"""Row mapping and query helpers. All SQL lives here or in migrations."""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

import duckdb
import orjson

from atlas.models import Change, ExternalRef, Hazard, Observation, TrackPoint

OBS_COLUMNS = (
    "id, source, external_id, hazard, title, lat, lon, depth_km, magnitude, magnitude_unit, alert_level, status, "
    "event_time, end_time, source_updated_at, first_seen_at, last_seen_at, url, country_iso3, description, metrics, "
    "geometry, track, external_refs, names, content_hash, version, incident_id, incident_candidate, retracted"
)


def dumps(value: Any) -> str | None:
    if value is None:
        return None
    return orjson.dumps(value, option=orjson.OPT_SORT_KEYS | orjson.OPT_NAIVE_UTC).decode()


def loads(value: str | None) -> Any:
    if value is None:
        return None
    return orjson.loads(value)


@dataclass
class ObsRow:
    obs: Observation
    first_seen_at: datetime
    last_seen_at: datetime
    content_hash: str
    version: int
    incident_id: str | None
    retracted: bool


def row_to_obs(r: Sequence[Any]) -> ObsRow:
    (_oid, source, external_id, hazard, title, lat, lon, depth, mag, mag_unit, alert, status, event_time, end_time,
     updated, first_seen, last_seen, url, iso3, desc, metrics, geometry, track, refs, names, chash, version,
     incident_id, candidate, retracted) = r  # fmt: skip
    obs = Observation(
        source=source, external_id=external_id, hazard=Hazard(hazard), title=title, lat=lat, lon=lon,
        depth_km=depth, magnitude=mag, magnitude_unit=mag_unit, alert_level=alert, status=status,
        event_time=event_time, end_time=end_time, source_updated_at=updated, url=url, country_iso3=iso3,
        description=desc, metrics=loads(metrics) or {}, geometry=loads(geometry),
        track=[TrackPoint.model_validate(t) for t in loads(track) or []],
        external_refs=[ExternalRef.model_validate(x) for x in loads(refs) or []],
        names=loads(names) or [], incident_candidate=bool(candidate),
    )  # fmt: skip
    return ObsRow(obs, first_seen, last_seen, chash, version, incident_id, bool(retracted))


def obs_params(obs: Observation, *, first_seen: datetime, last_seen: datetime, chash: str, version: int,
               incident_id: str | None, retracted: bool = False) -> list[Any]:  # fmt: skip
    return [
        obs.id, obs.source, obs.external_id, obs.hazard.value, obs.title, obs.lat, obs.lon, obs.depth_km,
        obs.magnitude, obs.magnitude_unit, obs.alert_level, obs.status, obs.event_time, obs.end_time,
        obs.source_updated_at, first_seen, last_seen, obs.url, obs.country_iso3, obs.description,
        dumps(obs.metrics), dumps(obs.geometry), dumps([t.model_dump(mode="json") for t in obs.track]) if obs.track else None,
        dumps([r.model_dump() for r in obs.external_refs]), dumps(obs.names), chash, version, incident_id,
        obs.incident_candidate, retracted,
    ]  # fmt: skip


def upsert_observation(cur: duckdb.DuckDBPyConnection, params: list[Any]) -> None:
    placeholders = ", ".join("?" for _ in params)
    cur.execute(f"INSERT OR REPLACE INTO observations ({OBS_COLUMNS}) VALUES ({placeholders})", params)


def insert_version(cur: duckdb.DuckDBPyConnection, obs: Observation, version: int, recorded_at: datetime, chash: str) -> None:
    cur.execute(
        "INSERT OR REPLACE INTO observation_versions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
            obs.id,
            version,
            recorded_at,
            obs.source_updated_at,
            obs.lat,
            obs.lon,
            obs.depth_km,
            obs.magnitude,
            obs.alert_level,
            obs.status,
            dumps(obs.metrics),
            chash,
        ],  # fmt: skip
    )


def replace_refs(cur: duckdb.DuckDBPyConnection, obs: Observation) -> None:
    cur.execute("DELETE FROM external_refs WHERE observation_id = ?", [obs.id])
    for ref in obs.external_refs:
        cur.execute("INSERT OR IGNORE INTO external_refs VALUES (?, ?, ?)", [ref.scheme, ref.id, obs.id])


def load_observations(cur: duckdb.DuckDBPyConnection, ids: Sequence[str]) -> dict[str, ObsRow]:
    out: dict[str, ObsRow] = {}
    for chunk in _chunks(list(ids), 500):
        rows = cur.execute(
            f"SELECT {OBS_COLUMNS} FROM observations WHERE id IN (SELECT unnest(?::VARCHAR[]))", [chunk]
        ).fetchall()
        for r in rows:
            row = row_to_obs(r)
            out[row.obs.id] = row
    return out


def observations_for_incident(cur: duckdb.DuckDBPyConnection, incident_id: str) -> list[ObsRow]:
    rows = cur.execute(
        f"SELECT {OBS_COLUMNS} FROM observations WHERE incident_id = ? AND NOT retracted ORDER BY event_time", [incident_id]
    ).fetchall()
    return [row_to_obs(r) for r in rows]


def incidents_for_refs(cur: duckdb.DuckDBPyConnection, refs: Iterable[ExternalRef], exclude_obs: str) -> list[str]:
    pairs = [(r.scheme, r.id) for r in refs]
    if not pairs:
        return []
    schemes = [p[0] for p in pairs]
    ids = [p[1] for p in pairs]
    rows = cur.execute(
        """
        SELECT o.incident_id FROM external_refs e
        JOIN (SELECT unnest(?::VARCHAR[]) AS scheme, unnest(?::VARCHAR[]) AS ref) q
          ON e.scheme = q.scheme AND e.ref = q.ref
        JOIN observations o ON o.id = e.observation_id
        WHERE o.incident_id IS NOT NULL AND o.id <> ? AND NOT o.retracted
        """,
        [schemes, ids, exclude_obs],
    ).fetchall()
    return [r[0] for r in rows]


def touch_seen(cur: duckdb.DuckDBPyConnection, ids: Sequence[str], at: datetime) -> None:
    for chunk in _chunks(list(ids), 2000):
        cur.execute("UPDATE observations SET last_seen_at = ? WHERE id IN (SELECT unnest(?::VARCHAR[]))", [at, chunk])


def insert_change(cur: duckdb.DuckDBPyConnection, c: Change) -> int:
    row = cur.execute(
        "INSERT INTO incident_changes (incident_id, changed_at, kind, field, old_value, new_value, source, observation_id, summary, significance) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
        [c.incident_id, c.at, c.kind, c.field, c.old_value, c.new_value, c.source, c.observation_id, c.summary, c.significance],
    ).fetchone()
    return int(row[0]) if row else 0


CHANGE_COLUMNS = "id, incident_id, changed_at, kind, field, old_value, new_value, source, observation_id, summary, significance"


def row_to_change(r: Sequence[Any]) -> Change:
    return Change(id=r[0], incident_id=r[1], at=r[2], kind=r[3], field=r[4], old_value=r[5], new_value=r[6],
                  source=r[7], observation_id=r[8], summary=r[9], significance=r[10])  # fmt: skip


INCIDENT_COLUMNS = (
    "id, hazard, title, status, lat, lon, bbox, geometry, started_at, ended_at, created_at, updated_at, "
    "last_observation_at, severity_level, severity, confidence, headline, country_iso3, country_name, place, "
    "source_count, sources, primary_observation, revision"
)


@dataclass
class IncidentRecord:
    id: str
    hazard: Hazard
    title: str
    status: str
    lat: float | None
    lon: float | None
    bbox: list[float] | None
    geometry: dict[str, Any] | None
    started_at: datetime
    ended_at: datetime | None
    created_at: datetime
    updated_at: datetime
    last_observation_at: datetime
    severity_level: int
    severity: dict[str, Any]
    confidence: dict[str, Any]
    headline: list[dict[str, Any]]
    country_iso3: str | None
    country_name: str | None
    place: dict[str, Any] | None
    source_count: int
    sources: list[str]
    primary_observation: str
    revision: int = 1
    extra: dict[str, Any] = field(default_factory=dict)

    def params(self) -> list[Any]:
        return [
            self.id, self.hazard.value, self.title, self.status, self.lat, self.lon, dumps(self.bbox),
            dumps(self.geometry), self.started_at, self.ended_at, self.created_at, self.updated_at,
            self.last_observation_at, self.severity_level, dumps(self.severity), dumps(self.confidence),
            dumps(self.headline), self.country_iso3, self.country_name, dumps(self.place), self.source_count,
            dumps(self.sources), self.primary_observation, self.revision,
        ]  # fmt: skip


def row_to_incident(r: Sequence[Any]) -> IncidentRecord:
    return IncidentRecord(
        id=r[0], hazard=Hazard(r[1]), title=r[2], status=r[3], lat=r[4], lon=r[5], bbox=loads(r[6]),
        geometry=loads(r[7]), started_at=r[8], ended_at=r[9], created_at=r[10], updated_at=r[11],
        last_observation_at=r[12], severity_level=r[13], severity=loads(r[14]), confidence=loads(r[15]),
        headline=loads(r[16]), country_iso3=r[17], country_name=r[18], place=loads(r[19]), source_count=r[20],
        sources=loads(r[21]), primary_observation=r[22], revision=r[23],
    )  # fmt: skip


def load_incident(cur: duckdb.DuckDBPyConnection, incident_id: str) -> IncidentRecord | None:
    r = cur.execute(f"SELECT {INCIDENT_COLUMNS} FROM incidents WHERE id = ?", [incident_id]).fetchone()
    return row_to_incident(r) if r else None


def upsert_incident(cur: duckdb.DuckDBPyConnection, rec: IncidentRecord) -> None:
    params = rec.params()
    placeholders = ", ".join("?" for _ in params)
    cur.execute(f"INSERT OR REPLACE INTO incidents ({INCIDENT_COLUMNS}) VALUES ({placeholders})", params)


def record_sync(cur: duckdb.DuckDBPyConnection, **fields: Any) -> None:
    cols = ", ".join(fields)
    placeholders = ", ".join("?" for _ in fields)
    cur.execute(f"INSERT INTO sync_runs ({cols}) VALUES ({placeholders})", list(fields.values()))


def _chunks(items: list[str], n: int) -> Iterable[list[str]]:
    for i in range(0, len(items), n):
        yield items[i : i + n]
