"""Application runtime: owns long-lived services and runs connector jobs end-to-end."""

from __future__ import annotations

import asyncio
import logging
from datetime import timedelta
from pathlib import Path
from typing import Any

from pydantic import SecretStr

from atlas.config import Settings
from atlas.connectors import CONNECTORS, ConnectorContext, DataConnector, FetchOutcome
from atlas.engine.exposure import PopulationGrid
from atlas.engine.fires import FireEngine
from atlas.engine.geocode import Geocoder
from atlas.engine.pipeline import IngestPipeline
from atlas.engine.spectral import SpectralService
from atlas.http.cache import HttpCache
from atlas.http.client import HostPolicy, HttpClient
from atlas.http.security import UrlPolicy
from atlas.jobs.bus import EventBus
from atlas.jobs.scheduler import Scheduler
from atlas.observability import metrics
from atlas.packs import PackManager
from atlas.registry import Registry, load_registry
from atlas.store import repo
from atlas.store.db import Database
from atlas.util.timeutil import iso_z, utcnow

log = logging.getLogger("atlas.runtime")


class Runtime:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        settings.ensure_dirs()
        self.registry: Registry = load_registry(settings.registry_path)
        self.db = Database(settings.db_path)
        self.db.migrate()
        self.cache = HttpCache(settings.cache_dir / "http")
        self.http = HttpClient(
            self.cache, UrlPolicy(self.registry.all_hosts()), timeout_s=settings.http_timeout_s,
            max_bytes=settings.http_max_bytes, offline=settings.offline,
        )  # fmt: skip
        self.http.set_host_policy("overpass-api.de", HostPolicy(max_concurrency=1, min_interval_s=2.0))
        self.http.set_host_policy("www.gdacs.org", HostPolicy(max_concurrency=2, min_interval_s=0.5))
        self.http.set_host_policy("api.open-meteo.com", HostPolicy(max_concurrency=2, min_interval_s=0.2))
        self.http.set_host_policy("api.openaq.org", HostPolicy(max_concurrency=1, min_interval_s=1.1))  # 60 requests/min
        self.packs = PackManager(settings.packs_dir, self.http)
        self.spectral = SpectralService(self.http, settings.cache_dir, offline=settings.offline, core_dir=self.packs.path("core"))
        self.geocoder = self._load_geocoder()
        self.bus = EventBus()
        self.pipeline = IngestPipeline(self.db, self.geocoder, self.registry, self.bus)
        self.pipeline.load_snapshots()
        self.population: PopulationGrid | None = None
        self.reload_population()
        self.fires = FireEngine(self.db, settings.fire_window_hours)
        ctx = ConnectorContext(http=self.http, settings=settings, registry=self.registry)
        self.connectors: dict[str, DataConnector] = {c.id: c(ctx) for c in CONNECTORS}
        self.scheduler = Scheduler(max_concurrency=3)
        self.started_at = utcnow()
        # Desktop Settings: background pack installs/imports and their progress, by pack id.
        self.pack_tasks: dict[str, dict[str, Any]] = {}
        self._background: set[asyncio.Task[None]] = set()

    def _load_geocoder(self) -> Geocoder:
        core = self.packs.path("core")
        return Geocoder(core / "countries_50m.geojson", core / "places.geojson", core / "admin1_50m.geojson")

    def reload_population(self) -> bool:
        """(Re)open the optional GHSL population grid; returns whether it is available."""
        self.population = PopulationGrid.find(self.packs.path("population-ghsl"))
        self.pipeline.population = self.population
        if self.population is not None:
            log.info("population grid ready: %s", self.population.path.name)
        return self.population is not None

    def reload_geocoder(self) -> None:
        self.geocoder = self._load_geocoder()
        self.pipeline.geocoder = self.geocoder

    # ----------------------------------------------------------------- desktop Settings
    def set_credential(self, name: str, value: str | None) -> None:
        """Apply an API credential entered in Settings to the running engine."""
        if name == "openaq_api_key":
            self.settings.openaq_api_key = SecretStr(value) if value else None
        elif name == "reliefweb_appname":
            self.settings.reliefweb_appname = value or None
        else:
            raise KeyError(name)

    async def refresh_connector(self, cid: str) -> None:
        """(Un)schedule a connector whose availability changed while running (a key set in Settings)."""
        conn = self.connectors.get(cid)
        if conn is None or not self.settings.scheduler_enabled:
            return
        ok, _why = self.availability()[cid]
        scheduled = any(job.group == cid for job in self.scheduler.jobs.values())
        if not ok:
            self.scheduler.remove_group(cid)
            return
        if scheduled:
            self.scheduler.trigger_group(cid)  # new key: fetch now
            return
        await conn.initialize()
        for job in conn.jobs():
            self.scheduler.add(job.name, cid, job.interval, self._wrap(conn, job.name, job.run), start_delay=1.0)
        self.scheduler.wake()

    def start_pack_task(self, pack_id: str, source: Path | None = None) -> dict[str, Any]:
        """Install (download) a pack, or import it from `source`, in the background."""
        current = self.pack_tasks.get(pack_id)
        if current and current["state"] in ("starting", "downloading", "extracting", "copying", "indexing"):
            return current
        state: dict[str, Any] = {
            "pack": pack_id, "state": "starting", "done": 0, "total": None, "error": None,
            "mode": "import" if source else "download", "started_at": iso_z(utcnow()),
        }  # fmt: skip
        self.pack_tasks[pack_id] = state

        def progress(stage: str, done: int, total: int | None) -> None:
            state.update(state=stage, done=done, total=total)

        async def run() -> None:
            try:
                if pack_id == "population-ghsl":
                    self._release_population()
                if source is not None:
                    await asyncio.to_thread(self.packs.import_from, pack_id, source, progress=progress)
                else:
                    await self.packs.install(pack_id, force=True, progress=progress)
                state.update(state="indexing")
                await self._after_pack(pack_id)
                state.update(state="done", finished_at=iso_z(utcnow()))
            except Exception as exc:  # reported to the Settings view
                log.warning("pack %s failed: %s", pack_id, exc)
                message = str(exc) if isinstance(exc, ValueError) else f"{type(exc).__name__}: {exc}"
                state.update(state="error", error=message[:300])
                if pack_id == "population-ghsl" and self.population is None:
                    self.reload_population()  # keep using a copy that was already there

        task = asyncio.create_task(run(), name=f"pack:{pack_id}")
        self._background.add(task)
        task.add_done_callback(self._background.discard)
        return state

    async def _after_pack(self, pack_id: str) -> None:
        if pack_id == "population-ghsl":
            if not self.reload_population():
                self.packs.remove(pack_id)
                raise ValueError("The population grid could not be opened; the pack was removed.")
            await asyncio.to_thread(self.pipeline.sweep)  # recompute exposure for open incidents
        elif pack_id == "core":
            self.reload_geocoder()

    def _release_population(self) -> None:
        grid, self.population = self.population, None
        self.pipeline.population = None
        if grid is not None:
            grid.close()

    def remove_pack(self, pack_id: str) -> bool:
        if pack_id == "population-ghsl":
            self._release_population()
        removed = self.packs.remove(pack_id)
        if pack_id == "population-ghsl":
            self.reload_population()
        self.pack_tasks.pop(pack_id, None)
        return removed

    # ------------------------------------------------------------------------------------
    def availability(self) -> dict[str, tuple[bool, str | None]]:
        out = {}
        for cid, c in self.connectors.items():
            meta = self.registry.get(cid)
            ok, why = c.availability()
            if ok and meta and not meta.default_enabled and not meta.auth.required:
                ok, why = False, "Disabled by default"
            out[cid] = (ok, why)
        return out

    async def start(self) -> None:
        self.bus.bind(asyncio.get_running_loop())
        if not self.packs.installed("core"):
            log.warning("Core Pack not installed: geocoding unavailable. Run `atlas setup`.")
        if not self.settings.scheduler_enabled:
            return
        delay = 0.0
        for cid, conn in self.connectors.items():
            ok, why = self.availability()[cid]
            if not ok:
                log.info("connector %s disabled: %s", cid, why)
                continue
            await conn.initialize()
            for job in conn.jobs():
                self.scheduler.add(job.name, cid, job.interval, self._wrap(conn, job.name, job.run),
                                   run_on_start=job.run_on_start, start_delay=delay)  # fmt: skip
                delay += 1.5  # stagger first runs: be a good citizen on startup
        self.scheduler.add("system.sweep", "system", timedelta(minutes=10), self._sweep, start_delay=90)
        self.scheduler.add("system.checkpoint", "system", timedelta(hours=1), self._checkpoint, run_on_start=False)
        self.scheduler.start()

    async def stop(self) -> None:
        await self.scheduler.stop()
        await self.http.aclose()
        assistant = getattr(self, "assistant", None)
        if assistant is not None:
            await assistant.client.aclose()
        self.db.checkpoint()
        self.db.close()

    def _wrap(self, conn: DataConnector, job_name: str, run: Any) -> Any:
        async def runner() -> None:
            await self.run_sync(conn, job_name, run)

        return runner

    async def run_sync(self, conn: DataConnector, job_name: str, run: Any) -> dict[str, Any]:
        started = utcnow()
        status, message = "ok", None
        outcome = FetchOutcome()
        stats: dict[str, Any] = {}
        try:
            with metrics.timer(f"job.{job_name}"):
                outcome = await run()
                stats = await asyncio.to_thread(self._process, conn.id, outcome)
            if outcome.stale:
                status, message = "degraded", "Upstream unavailable; served cached data"
            elif outcome.notes:
                status, message = "degraded", "; ".join(outcome.notes)[:900]
        except Exception as exc:
            status, message = "error", f"{type(exc).__name__}: {exc}"[:900]
            metrics.inc(f"sync.error.{conn.id}")
            raise
        finally:
            finished = utcnow()
            with self.db.write() as cur:
                repo.record_sync(
                    cur, source=conn.id, started_at=started, finished_at=finished, status=status,
                    records_received=outcome.received, records_accepted=len(outcome.observations) + stats.get("detections", 0),
                    records_rejected=outcome.rejected, records_changed=stats.get("changed", 0), bytes=outcome.bytes,
                    latency_ms=round(outcome.latency_ms, 1), from_cache=outcome.from_cache, stale=outcome.stale,
                    snapshot=outcome.complete_snapshot and status != "error", data_time=outcome.data_time,
                    message=(f"[{job_name}] " + message) if message else f"[{job_name}]",
                )  # fmt: skip
            self.bus.publish("source.synced", {"source": conn.id, "job": job_name, "status": status, "message": message,
                                               "at": iso_z(finished), **{k: v for k, v in stats.items() if isinstance(v, int)}})  # fmt: skip
        return stats

    def _process(self, source: str, outcome: FetchOutcome) -> dict[str, Any]:
        stats: dict[str, Any] = {}
        if outcome.detection_files:
            loaded = self.fires.load(outcome.detection_files)
            result = self.fires.cluster()
            stats["detections"] = sum(loaded.values())
            stats["clusters"] = result.tracked
            report = self.pipeline.ingest(source, result.observations, complete_snapshot=True)
        else:
            report = self.pipeline.ingest(source, outcome.observations, complete_snapshot=outcome.complete_snapshot)
        stats.update(
            changed=report.changed + report.inserted,
            incidents_created=len(report.incidents_created),
            incidents_updated=len(report.incidents_updated),
        )
        metrics.inc(f"ingest.records.{source}", report.received)
        return stats

    async def _sweep(self) -> None:
        await asyncio.to_thread(self.pipeline.sweep)

    async def _checkpoint(self) -> None:
        await asyncio.to_thread(self.db.checkpoint)

    async def sync_now(self, source: str) -> dict[str, Any]:
        conn = self.connectors[source]
        results = {}
        for job in conn.jobs():
            results[job.name] = await self.run_sync(conn, job.name, job.run)
        return results
