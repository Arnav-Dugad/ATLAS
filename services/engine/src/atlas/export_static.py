"""Static snapshot export for the free public demo (GitHub Pages).

Writes JSON files that mirror the API paths (``api/v1/overview`` → ``api/v1/overview.json``)
so the web client can run read-only from a CDN with no server. Live-only capabilities
(SSE, archive search, OpenStreetMap scans, weather) are absent by design and the client says
so.
"""

from __future__ import annotations

import json
import logging
from datetime import timedelta
from pathlib import Path
from typing import Any

import orjson

from atlas import __version__
from atlas.api.service import QueryService
from atlas.engine import exposure
from atlas.engine.fires import fire_grid
from atlas.runtime import Runtime
from atlas.util.timeutil import iso_z, utcnow

log = logging.getLogger("atlas.export")


def _write(root: Path, rel: str, payload: Any) -> int:
    path = root / f"{rel}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    data = orjson.dumps(payload, option=orjson.OPT_NAIVE_UTC | orjson.OPT_SERIALIZE_NUMPY)
    path.write_bytes(data)
    return len(data)


def _dump(model: Any) -> Any:
    return model.model_dump(mode="json") if hasattr(model, "model_dump") else model


def export_static(rt: Runtime, out: Path) -> dict[str, Any]:
    svc = QueryService(rt)
    root = out / "api" / "v1"
    now = utcnow()
    sizes: dict[str, int] = {}

    sources = svc.sources()
    sizes["sources"] = _write(root, "sources", [_dump(s) for s in sources])
    sizes["overview"] = _write(root, "overview", _dump(svc.overview(sources)))

    items, total = svc.list_incidents(
        status=None, hazards=None, min_severity=0, q=None, bbox=None, since=now - timedelta(days=30),
        until=None, country=None, sort="severity", limit=3000,
    )  # fmt: skip
    sizes["incidents"] = _write(
        root, "incidents", {"items": [_dump(i) for i in items], "total": total, "generated_at": iso_z(now)}
    )

    detail_bytes = 0
    for inc in items:
        detail = svc.get_incident(inc.id)
        if detail is None:
            continue
        detail_bytes += _write(root, f"incidents/{inc.id}", _dump(detail))
        if rt.population is not None and inc.lat is not None and inc.lon is not None:
            from atlas.models import Hazard

            pop = exposure.population_exposure(rt.population, Hazard(inc.hazard), inc.lat, inc.lon)
            _write(root, f"incidents/{inc.id}/exposure/population", pop)
    sizes["incident_details"] = detail_bytes

    with rt.db.read() as cur:
        rows = cur.execute(
            "SELECT external_id, lat, lon, depth_km, magnitude, epoch_ms(event_time), alert_level, incident_id, "
            "CAST(json_extract(metrics, '$.sig') AS INTEGER), CAST(json_extract(metrics, '$.tsunami') AS BOOLEAN), status "
            "FROM observations WHERE source = 'usgs' AND NOT retracted AND event_time >= ? ORDER BY event_time",
            [now - timedelta(days=30)],
        ).fetchall()
    cols = ["id", "lat", "lon", "depth", "mag", "t", "alert", "incident", "sig", "tsunami", "status"]
    sizes["earthquakes"] = _write(
        root,
        "layers/earthquakes",
        {
            "count": len(rows),
            "columns": {c: [r[i] for r in rows] for i, c in enumerate(cols)},
            "generated_at": iso_z(now),
            "attribution": ["Earthquake data: U.S. Geological Survey (USGS)"],
        },  # fmt: skip
    )

    cells = fire_grid(rt.db, 5, now - timedelta(hours=48))
    gcols = ["cell", "lat", "lon", "count", "frp", "latest", "high"]
    grid = {c: [x[c] for x in cells] for c in gcols}
    grid["latest"] = [int(v.timestamp() * 1000) if v is not None else None for v in grid["latest"]]
    sizes["fire_grid"] = _write(
        root, "layers/fires/grid",
        {"count": len(cells), "columns": grid, "generated_at": iso_z(now),
         "attribution": ["NASA LANCE FIRMS (VIIRS/MODIS); aggregated to H3 by ATLAS"], "note": "H3 resolution 5"},
    )  # fmt: skip

    with rt.db.read() as cur:
        crow = cur.execute(
            "SELECT id, lat, lon, hull, detections, footprint_km2, frp_total, frp_max, first_seen, last_seen, recent_12h, prior_12h, static_suspect "
            "FROM fire_clusters WHERE detections >= 25 ORDER BY frp_total DESC"
        ).fetchall()
    sizes["fire_clusters"] = _write(
        root, "layers/fires/clusters",
        {"type": "FeatureCollection", "attribution": ["NASA LANCE FIRMS; clusters derived by ATLAS (H3 r7 connectivity)"],
         "features": [
             {"type": "Feature", "geometry": orjson.loads(r[3]) if r[3] else None,
              "properties": {"id": r[0], "lat": r[1], "lon": r[2], "detections": r[4], "footprint_km2": r[5], "frp_total": r[6],
                             "frp_max": r[7], "first_seen": iso_z(r[8]), "last_seen": iso_z(r[9]), "recent_12h": r[10],
                             "prior_12h": r[11], "static_suspect": r[12]}} for r in crow]},
    )  # fmt: skip

    countries_path = rt.packs.file("core", "countries_110m.geojson")
    if countries_path:
        data = orjson.loads(countries_path.read_bytes())
        slim = {
            "type": "FeatureCollection",
            "features": [
                {
                    "type": "Feature",
                    "geometry": f["geometry"],
                    "properties": {"name": f["properties"].get("NAME"), "iso3": f["properties"].get("ISO_A3")},
                }  # fmt: skip
                for f in data.get("features", [])
            ],
        }
        sizes["countries"] = _write(root, "geo/countries", slim)

    with rt.db.read() as cur:
        changes = cur.execute(
            "SELECT c.id, c.incident_id, c.changed_at, c.kind, c.summary, c.significance, c.source, i.title, i.hazard, i.severity_level "
            "FROM incident_changes c JOIN incidents i ON i.id = c.incident_id WHERE c.changed_at >= ? AND c.significance >= 2 "
            "ORDER BY c.changed_at DESC LIMIT 200",
            [now - timedelta(days=3)],
        ).fetchall()
    _write(root, "changes", {"items": [
        {"id": r[0], "incident_id": r[1], "at": iso_z(r[2]), "kind": r[3], "summary": r[4], "significance": r[5], "source": r[6],
         "incident_title": r[7], "hazard": r[8], "severity_level": r[9]} for r in changes]})  # fmt: skip

    meta = {
        "name": "ATLAS",
        "version": __version__,
        "started_at": iso_z(rt.started_at),
        "now": iso_z(now),
        "offline": False,
        "registry_verified_at": rt.registry.verified_at,
        "duckdb_extensions": rt.db.extensions,
        "geocoder": rt.geocoder.available,
        "packs": rt.packs.status(),
        "connectors": {k: {"enabled": v[0], "reason": v[1]} for k, v in rt.availability().items()},
        "attribution": [s.attribution for s in rt.registry.sources.values() if s.default_enabled],
    }
    _write(root, "meta", meta)
    snapshot = {
        "generated_at": iso_z(now),
        "version": __version__,
        "incidents": total,
        "population_exposure": rt.population is not None,
        "note": "Public snapshot generated by GitHub Actions. Run ATLAS locally for live streaming, archive search and exposure scans.",
        "bytes": sizes,
    }
    (out / "snapshot.json").write_text(json.dumps(snapshot, indent=2), "utf-8")
    log.info("static snapshot: %d incidents, %.1f MB", total, sum(sizes.values()) / 1e6)
    return snapshot


async def export_spectral(rt: Runtime, out: Path, *, limit: int = 6, budget_s: float = 240.0) -> list[str]:
    """Precompute Sentinel-2 change maps for a few significant fires and floods (the public
    snapshot cannot run the analysis on demand). Bounded by count and wall time; results are
    reused from the 12 h cache between runs."""
    import asyncio
    import shutil
    import time

    from atlas.models import Hazard

    now = utcnow()
    with rt.db.read() as cur:
        rows = cur.execute(
            "SELECT id, hazard, lat, lon, bbox, started_at FROM incidents WHERE status = 'active' AND lat IS NOT NULL "
            "AND hazard IN ('wildfire', 'flood') AND started_at <= ? AND started_at >= ? "
            "ORDER BY severity_level DESC, last_observation_at DESC LIMIT ?",
            [now - timedelta(days=3), now - timedelta(days=40), limit * 2],
        ).fetchall()
    done: list[str] = []
    t0 = time.monotonic()
    root = out / "api" / "v1"
    for iid, hazard, lat, lon, bbox, started in rows:
        if len(done) >= limit or time.monotonic() - t0 > budget_s:
            break
        try:
            res = await rt.spectral.analyse(
                iid, Hazard(hazard), float(lat), float(lon), orjson.loads(bbox) if bbox else None, started
            )
        except Exception as exc:  # one failure must not sink the snapshot
            log.warning("static spectral: %s failed: %s", iid, exc)
            continue
        if res.get("status") != "ok":
            continue
        index = res["index"]["id"]
        src = rt.spectral.path(iid, index)
        dst = root / "imagery" / "files" / iid / index
        await asyncio.to_thread(shutil.copytree, src, dst, dirs_exist_ok=True)
        await asyncio.to_thread(_write, root, f"incidents/{iid}/imagery/change", res)
        done.append(iid)
    log.info("static spectral: %d change maps in %.0f s", len(done), time.monotonic() - t0)
    return done
