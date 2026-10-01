"""Ingest pipeline: observations in, versioned history + correlated incidents + audit trail out.

One write transaction per batch. Steps:
  1. upsert observations, versioning any material change (append-only history)
  2. correlate new/changed observations to incidents (external ids, then space-time)
  3. open incidents for qualifying observations that matched nothing
  4. re-fuse every affected incident and diff it against its previous state
  5. after commit, publish change events to the live stream
"""

from __future__ import annotations

import logging
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import datetime, timedelta

from atlas.engine.changes import incident_diffs, observation_diffs
from atlas.engine.correlate import Correlator, IncidentKey
from atlas.engine.exposure import PopulationGrid
from atlas.engine.fusion import FusionContext, fuse
from atlas.engine.geocode import Geocoder
from atlas.jobs.bus import EventBus
from atlas.models import HAZARD_CODE, Change, Hazard, Observation
from atlas.registry import Registry
from atlas.store import repo
from atlas.store.db import Database
from atlas.util.ids import content_hash, incident_id
from atlas.util.text import normalize_storm_name
from atlas.util.timeutil import iso_z, utcnow

log = logging.getLogger("atlas.pipeline")

CORRELATION_LOOKBACK = timedelta(days=45)


@dataclass
class IngestReport:
    source: str
    received: int = 0
    inserted: int = 0
    changed: int = 0
    unchanged: int = 0
    incidents_created: list[str] = field(default_factory=list)
    incidents_updated: list[str] = field(default_factory=list)
    changes: list[Change] = field(default_factory=list)


def material_hash(o: Observation) -> str:
    return content_hash(
        o.title, o.hazard.value, round(o.lat, 4) if o.lat is not None else None,
        round(o.lon, 4) if o.lon is not None else None, round(o.depth_km, 1) if o.depth_km is not None else None,
        round(o.magnitude, 2) if o.magnitude is not None else None, o.alert_level, o.status, o.end_time,
        sorted((k, str(v)) for k, v in o.metrics.items()), len(o.track),
        o.track[-1].model_dump_json() if o.track else None, bool(o.geometry), o.incident_candidate,
    )  # fmt: skip


class IngestPipeline:
    def __init__(self, db: Database, geocoder: Geocoder, registry: Registry, bus: EventBus) -> None:
        self.db = db
        self.geocoder = geocoder
        self.registry = registry
        self.bus = bus
        self.snapshots: dict[str, datetime] = {}
        self.population: PopulationGrid | None = None

    def load_snapshots(self) -> None:
        """Restore each complete-snapshot source's latest successful sync time."""
        with self.db.read() as cur:
            rows = cur.execute(
                "SELECT source, max(finished_at) FROM sync_runs WHERE snapshot AND status IN ('ok', 'degraded') GROUP BY source"
            ).fetchall()
        for src, at in rows:
            if at is not None:
                self.snapshots[src] = at

    # ------------------------------------------------------------------------------------
    def ingest(self, source: str, observations: list[Observation], *, complete_snapshot: bool,
               now: datetime | None = None) -> IngestReport:  # fmt: skip
        now = now or utcnow()
        report = IngestReport(source=source, received=len(observations))
        if complete_snapshot:
            self.snapshots[source] = now
        affected: dict[str, list[Change]] = {}

        with self.db.write() as cur:
            existing = repo.load_observations(cur, [o.id for o in observations])
            changed: list[tuple[Observation, repo.ObsRow | None]] = []
            unchanged_ids: list[str] = []
            for obs in observations:
                prev = existing.get(obs.id)
                if prev is not None:
                    _carry_over(obs, prev.obs)
                h = material_hash(obs)
                if prev is None:
                    repo.upsert_observation(
                        cur, repo.obs_params(obs, first_seen=now, last_seen=now, chash=h, version=1, incident_id=None)
                    )
                    repo.insert_version(cur, obs, 1, now, h)
                    repo.replace_refs(cur, obs)
                    changed.append((obs, None))
                    report.inserted += 1
                elif prev.content_hash != h:
                    version = prev.version + 1
                    repo.upsert_observation(cur, repo.obs_params(obs, first_seen=prev.first_seen_at, last_seen=now, chash=h,
                                                                 version=version, incident_id=prev.incident_id,
                                                                 retracted=obs.status == "deleted"))  # fmt: skip
                    repo.insert_version(cur, obs, version, now, h)
                    repo.replace_refs(cur, obs)
                    changed.append((obs, prev))
                    report.changed += 1
                else:
                    unchanged_ids.append(obs.id)
            repo.touch_seen(cur, unchanged_ids, now)
            report.unchanged = len(unchanged_ids)

            correlator = Correlator(self._candidate_keys(cur, {o.hazard for o, _ in changed}, now))
            for obs, prev in changed:
                inc_id = prev.incident_id if prev else None
                if inc_id is None:
                    ref_hits = repo.incidents_for_refs(cur, obs.external_refs, obs.id)
                    inc_id, method = correlator.match(obs, ref_hits)
                    if inc_id is None and obs.incident_candidate and obs.has_location() and obs.status != "deleted":
                        inc_id = incident_id(HAZARD_CODE.get(obs.hazard, "OT"), obs.event_time, obs.id)
                        correlator.add(_key_from_obs(inc_id, obs))
                        method = "founded"
                    if inc_id is not None:
                        cur.execute("UPDATE observations SET incident_id = ? WHERE id = ?", [inc_id, obs.id])
                        key = correlator.incidents.get(inc_id)
                        if key is not None:
                            key.absorb(obs)
                        log.debug("%s -> %s (%s)", obs.id, inc_id, method)
                if inc_id is None:
                    continue
                bucket = affected.setdefault(inc_id, [])
                if prev is not None:
                    bucket.extend(observation_diffs(inc_id, prev.obs, obs, now))

            if complete_snapshot:
                # Incidents whose observations from this source vanished from the feed may change status.
                for (iid,) in cur.execute(
                    "SELECT DISTINCT o.incident_id FROM observations o JOIN incidents i ON i.id = o.incident_id "
                    "WHERE o.source = ? AND o.last_seen_at < ? AND i.status <> 'closed'",
                    [source, now - timedelta(minutes=2)],
                ).fetchall():
                    affected.setdefault(iid, [])

            ctx = FusionContext(self.geocoder, self.registry, dict(self.snapshots), now, self.population)
            for inc_id, obs_changes in affected.items():
                created, inc_changes = self._refuse(cur, inc_id, ctx, obs_changes)
                if created:
                    report.incidents_created.append(inc_id)
                elif inc_changes or obs_changes:
                    report.incidents_updated.append(inc_id)
                report.changes.extend(inc_changes)

        self._publish(report)
        return report

    def _refuse(self, cur: object, inc_id: str, ctx: FusionContext, obs_changes: list[Change]) -> tuple[bool, list[Change]]:
        rows = repo.observations_for_incident(cur, inc_id)  # type: ignore[arg-type]
        previous = repo.load_incident(cur, inc_id)  # type: ignore[arg-type]
        if not rows:
            if previous is not None:
                cur.execute("UPDATE incidents SET status = 'closed', updated_at = ? WHERE id = ?", [ctx.now, inc_id])  # type: ignore[attr-defined]
            return False, []
        record = fuse(inc_id, rows, ctx, previous)
        diffs = obs_changes + incident_diffs(previous, record, ctx.now)
        if previous is not None and not diffs and _same(previous, record):
            return False, []
        repo.upsert_incident(cur, record)  # type: ignore[arg-type]
        stored: list[Change] = []
        for c in diffs:
            c.id = repo.insert_change(cur, c)  # type: ignore[arg-type]
            stored.append(c)
        return previous is None, stored

    def sweep(self, now: datetime | None = None) -> IngestReport:
        """Re-fuse open incidents so time-based status transitions happen without new data."""
        now = now or utcnow()
        report = IngestReport(source="sweep")
        with self.db.write() as cur:
            ids = [r[0] for r in cur.execute("SELECT id FROM incidents WHERE status <> 'closed'").fetchall()]
            ctx = FusionContext(self.geocoder, self.registry, dict(self.snapshots), now, self.population)
            for inc_id in ids:
                _created, changes = self._refuse(cur, inc_id, ctx, [])
                if changes:
                    report.incidents_updated.append(inc_id)
                    report.changes.extend(changes)
        self._publish(report)
        return report

    def _candidate_keys(self, cur: object, hazards: set[Hazard], now: datetime) -> Iterable[IncidentKey]:
        if not hazards:
            return []
        expanded = set(hazards)
        if Hazard.TROPICAL_CYCLONE in hazards or Hazard.SEVERE_STORM in hazards:
            expanded |= {Hazard.TROPICAL_CYCLONE, Hazard.SEVERE_STORM}
        rows = cur.execute(  # type: ignore[attr-defined]
            "SELECT i.id, i.hazard, i.lat, i.lon, i.started_at, i.last_observation_at, i.bbox, i.country_iso3, i.status, "
            "  (SELECT list(o.names) FROM observations o WHERE o.incident_id = i.id) AS names, "
            "  (SELECT max(o.magnitude) FROM observations o WHERE o.incident_id = i.id AND o.source = 'usgs') AS mag "
            "FROM incidents i WHERE i.hazard IN (SELECT unnest(?::VARCHAR[])) AND i.last_observation_at >= ?",
            [[h.value for h in expanded], now - CORRELATION_LOOKBACK],
        ).fetchall()
        keys = []
        for iid, hz, lat, lon, start, last, bbox, iso3, status, names, mag in rows:
            norm: set[str] = set()
            for blob in names or []:
                for n in repo.loads(blob) or []:
                    nn = normalize_storm_name(n)
                    if nn:
                        norm.add(nn)
            b = repo.loads(bbox)
            keys.append(IncidentKey(id=iid, hazard=Hazard(hz), lat=lat, lon=lon, started_at=start, last_observation_at=last,
                                    bbox=tuple(b) if b else None, names=norm, magnitude=mag, country_iso3=iso3,
                                    closed=status == "closed"))  # fmt: skip
        return keys

    def _publish(self, report: IngestReport) -> None:
        for iid in report.incidents_created:
            self.bus.publish("incident.created", {"id": iid, "source": report.source})
        for iid in report.incidents_updated:
            self.bus.publish("incident.updated", {"id": iid, "source": report.source})
        for c in report.changes:
            if c.kind == "created":
                continue
            self.bus.publish("incident.change", {**c.model_dump(mode="json"), "at": iso_z(c.at)})


def _carry_over(new: Observation, old: Observation) -> None:
    """Keep enrichment that a later fetch failed to repeat (e.g. a geometry request that
    timed out) so transient upstream failures don't masquerade as data changes."""
    if new.geometry is None and old.geometry is not None:
        new.geometry = old.geometry
    if not new.track and old.track:
        new.track = old.track
    refs = {(r.scheme, r.id): r for r in old.external_refs}
    refs.update({(r.scheme, r.id): r for r in new.external_refs})
    new.external_refs = sorted(refs.values(), key=lambda r: (r.scheme, r.id))


def _key_from_obs(inc_id: str, obs: Observation) -> IncidentKey:
    key = IncidentKey(id=inc_id, hazard=obs.hazard, lat=obs.lat, lon=obs.lon, started_at=obs.event_time,
                      last_observation_at=obs.source_updated_at or obs.event_time, magnitude=obs.magnitude,
                      country_iso3=obs.country_iso3)  # fmt: skip
    key.absorb(obs)
    return key


def _same(a: repo.IncidentRecord, b: repo.IncidentRecord) -> bool:
    return (
        a.title == b.title and a.status == b.status and a.severity_level == b.severity_level and a.lat == b.lat
        and a.lon == b.lon and a.headline == b.headline and a.sources == b.sources and a.geometry == b.geometry
        and a.confidence.get("score") == b.confidence.get("score") and a.last_observation_at == b.last_observation_at
    )  # fmt: skip
