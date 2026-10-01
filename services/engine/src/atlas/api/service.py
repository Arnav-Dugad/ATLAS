"""Read-side query service. Keeps SQL and shaping out of the route handlers."""

from __future__ import annotations

from collections.abc import Sequence
from datetime import datetime, timedelta
from typing import Any

from atlas.api.schemas import (
    ChangeOut,
    Citation,
    HazardCount,
    IncidentDetail,
    IncidentSummary,
    ObservationOut,
    OfficialLink,
    Overview,
    PlaceOut,
    RelatedIncident,
    SourceHealth,
    SourceStatus,
    SyncRunOut,
)
from atlas.engine import relations
from atlas.models import HAZARD_LABEL, Confidence, Hazard, Metric, Severity
from atlas.runtime import Runtime
from atlas.store import repo
from atlas.util.timeutil import utcnow

CONTRIBUTION: dict[str, str] = {
    "usgs": "Hypocentre, magnitude, PAGER alert, ShakeMap intensity, felt reports",
    "gdacs": "Alert level (impact model), affected countries, hazard polygons, cyclone track & cone",
    "nhc": "Official advisory position, intensity, pressure and motion",
    "eonet": "Curated event record and position history",
    "gvp": "Weekly volcanic activity report and observatory alert levels",
    "firms": "Satellite fire detections (clustered by ATLAS)",
    "reliefweb": "Humanitarian situation reporting",
}

HAZARD_LIMITATIONS: dict[Hazard, list[str]] = {
    Hazard.EARTHQUAKE: [
        "Automatic solutions are revised as more stations report; magnitude and location may change.",
        "PAGER and ShakeMap values are model estimates, not observed damage.",
        "ATLAS does not issue tsunami warnings. Follow your national tsunami warning centre.",
    ],
    Hazard.TROPICAL_CYCLONE: [
        "Forecast tracks and cones are forecasts by the issuing agency, not certainties; the cone shows track uncertainty, not impact extent.",
        "Wind buffers from GDACS are model products used for alerting.",
        "Follow your national meteorological service for warnings.",
    ],
    Hazard.WILDFIRE: [
        "Detections mark satellite pixels containing thermal anomalies; they are not fire perimeters.",
        "Clusters and footprints are ATLAS-derived groupings; nearby separate fires may merge.",
        "Cloud, smoke and overpass timing cause gaps; absence of detections is not absence of fire.",
    ],
    Hazard.VOLCANO: [
        "Weekly reports summarise observatory statements and may lag current activity by days.",
        "Follow the local volcano observatory and VAAC for current alerts.",
    ],
    Hazard.FLOOD: ["GDACS flood alerts are model-based; ATLAS does not derive flood extents in this version."],
    Hazard.DROUGHT: ["Drought alerts are aggregated from the Global Drought Observatory and evolve over weeks."],
}

GENERAL_LIMITATIONS = [
    "ATLAS is an information and research tool. It does not replace official alerts, evacuation orders or emergency services.",
    "Country attribution uses generalised Natural Earth boundaries and may be approximate near borders.",
]


def _severity(d: dict[str, Any]) -> Severity:
    return Severity.model_validate(d)


def summary(rec: repo.IncidentRecord, change_count: int = 0, last_change: ChangeOut | None = None) -> IncidentSummary:
    return IncidentSummary(
        id=rec.id, hazard=rec.hazard.value, hazard_label=HAZARD_LABEL.get(rec.hazard, rec.hazard.value), title=rec.title,
        status=rec.status, lat=rec.lat, lon=rec.lon, bbox=rec.bbox, started_at=rec.started_at, updated_at=rec.updated_at,
        last_observation_at=rec.last_observation_at, ended_at=rec.ended_at, severity=_severity(rec.severity),
        confidence=Confidence.model_validate(rec.confidence), headline=[Metric.model_validate(m) for m in rec.headline],
        country_iso3=rec.country_iso3, country_name=rec.country_name,
        place=PlaceOut.model_validate(rec.place) if rec.place else None, source_count=rec.source_count,
        sources=rec.sources, change_count=change_count, last_change=last_change,
    )  # fmt: skip


class QueryService:
    def __init__(self, rt: Runtime) -> None:
        self.rt = rt

    # -- incidents ---------------------------------------------------------------------
    def list_incidents(
        self, *, status: Sequence[str] | None, hazards: Sequence[str] | None, min_severity: int, q: str | None,
        bbox: Sequence[float] | None, since: datetime | None, until: datetime | None, country: str | None,
        sort: str, limit: int,
    ) -> tuple[list[IncidentSummary], int]:  # fmt: skip
        where, params = ["1=1"], []
        if status:
            where.append("i.status IN (SELECT unnest(?::VARCHAR[]))")
            params.append(list(status))
        if hazards:
            where.append("i.hazard IN (SELECT unnest(?::VARCHAR[]))")
            params.append(list(hazards))
        if min_severity:
            where.append("i.severity_level >= ?")
            params.append(min_severity)
        if q:
            where.append("(i.title ILIKE ? OR i.country_name ILIKE ? OR i.id ILIKE ?)")
            like = f"%{q}%"
            params += [like, like, like]
        if country:
            where.append("i.country_iso3 = ?")
            params.append(country.upper())
        if bbox and len(bbox) == 4:
            w, s, e, n = bbox
            where.append("i.lat BETWEEN ? AND ?")
            params += [s, n]
            if w <= e:
                where.append("i.lon BETWEEN ? AND ?")
                params += [w, e]
            else:
                where.append("(i.lon >= ? OR i.lon <= ?)")
                params += [w, e]
        if since:
            where.append("i.last_observation_at >= ?")
            params.append(since)
        if until:
            where.append("i.started_at <= ?")
            params.append(until)
        order = {
            "severity": "i.severity_level DESC, i.last_observation_at DESC",
            "updated": "i.updated_at DESC",
            "recent": "i.last_observation_at DESC",
            "started": "i.started_at DESC",
        }.get(sort, "i.severity_level DESC, i.last_observation_at DESC")
        sql_where = " AND ".join(where)
        with self.rt.db.read() as cur:
            total = cur.execute(f"SELECT count(*) FROM incidents i WHERE {sql_where}", params).fetchone()[0]  # type: ignore[index]
            rows = cur.execute(
                f"SELECT {', '.join('i.' + c.strip() for c in repo.INCIDENT_COLUMNS.split(','))} FROM incidents i "
                f"WHERE {sql_where} ORDER BY {order} LIMIT ?",
                [*params, limit],
            ).fetchall()
            recs = [repo.row_to_incident(r) for r in rows]
            counts = self._change_counts(cur, [r.id for r in recs])
        return [summary(r, *counts.get(r.id, (0, None))) for r in recs], int(total)

    def _change_counts(self, cur: Any, ids: list[str]) -> dict[str, tuple[int, ChangeOut | None]]:
        if not ids:
            return {}
        rows = cur.execute(
            f"""
            SELECT c.incident_id, n, {", ".join("c." + x.strip() for x in repo.CHANGE_COLUMNS.split(","))}
            FROM (SELECT incident_id, count(*) AS n, max(id) AS last_id FROM incident_changes
                  WHERE incident_id IN (SELECT unnest(?::VARCHAR[])) GROUP BY incident_id) agg
            JOIN incident_changes c ON c.id = agg.last_id
            """,
            [ids],
        ).fetchall()
        return {r[0]: (int(r[1]), ChangeOut.of(repo.row_to_change(r[2:]))) for r in rows}

    def get_incident(self, incident_id: str) -> IncidentDetail | None:
        with self.rt.db.read() as cur:
            rec = repo.load_incident(cur, incident_id)
            if rec is None:
                return None
            rows = repo.observations_for_incident(cur, incident_id)
            changes = [
                ChangeOut.of(repo.row_to_change(r))
                for r in cur.execute(
                    f"SELECT {repo.CHANGE_COLUMNS} FROM incident_changes WHERE incident_id = ? ORDER BY changed_at DESC, id DESC LIMIT 200",
                    [incident_id],
                ).fetchall()
            ]
            related = self._related(cur, rec)
        base = summary(rec, len(changes), changes[0] if changes else None)
        observations = [
            ObservationOut(
                id=r.obs.id,
                source=r.obs.source,
                source_name=self._source_name(r.obs.source),
                external_id=r.obs.external_id,
                hazard=r.obs.hazard.value,
                title=r.obs.title,
                lat=r.obs.lat,
                lon=r.obs.lon,
                depth_km=r.obs.depth_km,
                magnitude=r.obs.magnitude,
                magnitude_unit=r.obs.magnitude_unit,
                alert_level=r.obs.alert_level,
                status=r.obs.status,
                event_time=r.obs.event_time,
                end_time=r.obs.end_time,
                source_updated_at=r.obs.source_updated_at,
                first_seen_at=r.first_seen_at,
                last_seen_at=r.last_seen_at,
                url=r.obs.url,
                description=r.obs.description,
                metrics=r.obs.metrics,
                version=r.version,
            )  # fmt: skip
            for r in rows
        ]
        nearby = []
        if rec.lat is not None and rec.lon is not None:
            nearby = [
                PlaceOut.model_validate(p.model_dump())
                for p in self.rt.geocoder.nearest_places(rec.lat, rec.lon, k=8, max_km=500)
            ]
        geometry = dict(rec.geometry) if rec.geometry else None
        track = (geometry or {}).pop("track", []) if geometry else []
        hazard_limits = HAZARD_LIMITATIONS.get(rec.hazard, [])
        return IncidentDetail(
            **base.model_dump(), geometry=geometry, track=track, observations=observations, changes=changes,
            citations=self._citations(rows), official_links=self._official_links(rec, rows), nearby_places=nearby,
            related=related, limitations=[*hazard_limits, *GENERAL_LIMITATIONS],
        )  # fmt: skip

    def _source_name(self, sid: str) -> str:
        meta = self.rt.registry.get(sid)
        return meta.name if meta else sid

    def _citations(self, rows: Sequence[repo.ObsRow]) -> list[Citation]:
        out: dict[str, Citation] = {}
        for r in rows:
            meta = self.rt.registry.get(r.obs.source)
            if meta is None:
                continue
            prev = out.get(meta.id)
            if prev is not None and prev.retrieved_at and prev.retrieved_at >= r.last_seen_at:
                continue
            out[meta.id] = Citation(
                source_id=meta.id, name=meta.name, provider=meta.provider, attribution=meta.attribution,
                license=meta.license.name, license_url=meta.license.url, contributed=CONTRIBUTION.get(meta.id, meta.category),
                retrieved_at=r.last_seen_at, source_updated_at=r.obs.source_updated_at, url=r.obs.url,
                reliability=meta.reliability.rating,
            )  # fmt: skip
        for sid in ("natural-earth",):
            meta = self.rt.registry.get(sid)
            if meta:
                out[sid] = Citation(
                    source_id=sid, name=meta.name, provider=meta.provider, attribution=meta.attribution,
                    license=meta.license.name, license_url=meta.license.url, contributed="Country and place names (offline geocoding)",
                    retrieved_at=None, source_updated_at=None, url=meta.homepage, reliability=meta.reliability.rating,
                )  # fmt: skip
        return list(out.values())

    def _official_links(self, rec: repo.IncidentRecord, rows: Sequence[repo.ObsRow]) -> list[OfficialLink]:
        links: list[OfficialLink] = []
        for r in rows:
            o = r.obs
            if not o.url:
                continue
            if o.source == "usgs":
                links.append(OfficialLink(label="USGS event page", url=o.url, authority="U.S. Geological Survey"))
            elif o.source == "nhc":
                links.append(OfficialLink(label=f"NHC public advisory #{o.metrics.get('advisory_number') or ''}".strip(" #"),
                                          url=o.url, authority="NOAA National Hurricane Center"))  # fmt: skip
            elif o.source == "gdacs":
                links.append(OfficialLink(label="GDACS event report", url=o.url, authority="GDACS (EC JRC / UN OCHA)"))
            elif o.source == "gvp":
                links.append(OfficialLink(label="Smithsonian GVP weekly report", url=o.url, authority="Smithsonian / USGS"))
            elif o.source == "eonet":
                links.append(OfficialLink(label="NASA EONET record", url=o.url, authority="NASA"))
            elif o.source == "emsc":
                links.append(
                    OfficialLink(label="EMSC event page", url=o.url, authority="European-Mediterranean Seismological Centre")
                )
            elif o.source == "tsunami":
                links.insert(0, OfficialLink(label=f"Tsunami {o.metrics.get('tsunami_message') or 'message'} bulletin ({o.metrics.get('tsunami_centre')})",
                                             url=o.url, authority="NOAA Tsunami Warning Center"))  # fmt: skip
        if rec.hazard is Hazard.EARTHQUAKE:
            links.append(OfficialLink(label="Tsunami warning centres", url="https://www.tsunami.gov/", authority="NOAA"))
        if rec.hazard is Hazard.WILDFIRE and rec.lat is not None:
            links.append(OfficialLink(label="NASA FIRMS fire map", url=f"https://firms.modaps.eosdis.nasa.gov/map/#d:24hrs;@{rec.lon:.2f},{rec.lat:.2f},9z",
                                      authority="NASA"))  # fmt: skip
        seen: set[str] = set()
        return [x for x in links if not (x.url in seen or seen.add(x.url))]  # type: ignore[func-returns-value]

    def _related(self, cur: Any, rec: repo.IncidentRecord) -> list[RelatedIncident]:
        """Incidents linked by a documented relation rule (see engine/relations.py)."""
        if rec.lat is None or rec.lon is None:
            return []
        centre = relations.Node(rec.id, rec.title, rec.hazard.value, rec.severity_level, rec.status, rec.lat, rec.lon,
                                rec.started_at, rec.last_observation_at)  # fmt: skip
        found = relations._nodes(cur, "i.id = ?", [rec.id])
        if found:
            centre = found[0]
        out = [
            RelatedIncident(
                id=n.id,
                title=n.title,
                hazard=n.hazard,
                severity_level=n.severity_level,
                status=n.status,
                distance_km=relations.distance_km(centre, n),
                started_at=n.started_at,
                relation=e.type,
            )  # fmt: skip
            for n, e in relations.neighbours(cur, centre, limit=25)
        ]
        out.sort(key=lambda r: r.distance_km)
        return out

    # -- overview ---------------------------------------------------------------------
    def overview(self, sources: list[SourceStatus]) -> Overview:
        now = utcnow()
        with self.rt.db.read() as cur:
            hz = cur.execute(
                "SELECT hazard, count(*) FILTER (WHERE status='active'), count(*) FILTER (WHERE status='monitoring'), "
                "max(severity_level) FILTER (WHERE status <> 'closed') FROM incidents GROUP BY hazard"
            ).fetchall()
            sev = cur.execute("SELECT severity_level, count(*) FROM incidents WHERE status='active' GROUP BY 1").fetchall()
            eq = cur.execute(
                "SELECT count(*), max(magnitude) FROM observations WHERE source='usgs' AND hazard='earthquake' AND event_time >= ? AND NOT retracted",
                [now - timedelta(hours=24)],
            ).fetchone()
            fires = cur.execute(
                "SELECT count(*) FROM fire_detections WHERE acq_time >= ?", [now - timedelta(hours=24)]
            ).fetchone()
            clusters = cur.execute("SELECT count(*) FROM fire_clusters WHERE NOT static_suspect").fetchone()
            obs_total = cur.execute("SELECT count(*) FROM observations").fetchone()
            changes = [
                ChangeOut.of(repo.row_to_change(r))
                for r in cur.execute(
                    f"SELECT {repo.CHANGE_COLUMNS} FROM incident_changes WHERE significance >= 2 ORDER BY changed_at DESC, id DESC LIMIT 25"
                ).fetchall()
            ]
        by_hazard = [
            HazardCount(hazard=h, label=HAZARD_LABEL.get(Hazard(h), h), active=a or 0, monitoring=m or 0, max_severity=s or 0)
            for h, a, m, s in hz
        ]
        by_hazard.sort(key=lambda x: (-x.active, -x.max_severity))
        active = sum(x.active for x in by_hazard)
        monitoring = sum(x.monitoring for x in by_hazard)
        cyclones = next((x.active for x in by_hazard if x.hazard == "tropical_cyclone"), 0)
        return Overview(
            generated_at=now, incidents_active=active, incidents_monitoring=monitoring, by_hazard=by_hazard,
            severity_histogram={str(k): int(v) for k, v in sev}, earthquakes_24h=int(eq[0] or 0) if eq else 0,
            earthquakes_24h_max_mag=float(eq[1]) if eq and eq[1] is not None else None,
            fire_detections_24h=int(fires[0]) if fires else 0, fire_clusters=int(clusters[0]) if clusters else 0,
            active_cyclones=cyclones, recent_changes=changes,
            sources=[SourceHealth(id=s.id, name=s.meta["name"], status=s.status, last_ok=s.last_success, data_age_s=s.data_age_s)
                     for s in sources],
            observations_total=int(obs_total[0]) if obs_total else 0,
        )  # fmt: skip

    # -- sources ------------------------------------------------------------------------
    def sources(self, *, with_runs: bool = False, only: str | None = None) -> list[SourceStatus]:
        now = utcnow()
        avail = self.rt.availability()
        jobs = [j.snapshot() for j in self.rt.scheduler.jobs.values()]
        with self.rt.db.read() as cur:
            agg = {
                r[0]: r[1:]
                for r in cur.execute(
                    """
                    SELECT source,
                           max(started_at),
                           max(finished_at) FILTER (WHERE status IN ('ok','degraded')),
                           arg_max(message, started_at) FILTER (WHERE status = 'error'),
                           max(data_time),
                           quantile_cont(latency_ms, 0.5) FILTER (WHERE NOT from_cache),
                           count(*) FILTER (WHERE started_at >= ?),
                           count(*) FILTER (WHERE started_at >= ? AND status = 'error'),
                           coalesce(sum(bytes) FILTER (WHERE started_at >= ? AND NOT from_cache), 0),
                           arg_max(status, started_at)
                    FROM sync_runs GROUP BY source
                    """,
                    [now - timedelta(hours=24)] * 3,
                ).fetchall()
            }
            counts = dict(cur.execute("SELECT source, count(*) FROM observations GROUP BY source").fetchall())
            counts["firms"] = int(cur.execute("SELECT count(*) FROM fire_detections").fetchone()[0])  # type: ignore[index]
            runs: dict[str, list[SyncRunOut]] = {}
            if with_runs:
                for r in cur.execute(
                    "SELECT source, id, started_at, finished_at, status, records_received, records_accepted, records_rejected, "
                    "records_changed, bytes, latency_ms, from_cache, stale, data_time, message FROM sync_runs "
                    "WHERE (? IS NULL OR source = ?) ORDER BY started_at DESC LIMIT 400",
                    [only, only],
                ).fetchall():
                    runs.setdefault(r[0], [])
                    if len(runs[r[0]]) < 40:
                        runs[r[0]].append(SyncRunOut(id=r[1], started_at=r[2], finished_at=r[3], status=r[4], records_received=r[5],
                                                     records_accepted=r[6], records_rejected=r[7], records_changed=r[8], bytes=r[9],
                                                     latency_ms=r[10], from_cache=r[11], stale=r[12], data_time=r[13], message=r[14]))  # fmt: skip
        out = []
        for sid, meta in self.rt.registry.sources.items():
            if only and sid != only:
                continue
            enabled, reason = avail.get(sid, (True, None))
            a = agg.get(sid)
            last_attempt, last_ok, last_err, data_time, p50, n24, e24, b24, last_status = a if a else (None,) * 9
            if sid not in self.rt.connectors:
                # Reference datasets and on-demand services (no polling connector).
                configured = bool(
                    meta.auth.optional_env
                    and getattr(self.rt.settings, meta.auth.optional_env.removeprefix("ATLAS_").lower(), None)
                )
                if meta.auth.required and not configured:
                    status, enabled = "disabled", False
                    reason = reason or f"Requires a free key (set {meta.auth.optional_env})"
                elif meta.auth.required:
                    status, enabled = "reference", True
                else:
                    status, enabled = "reference", True
            elif not enabled:
                status = "disabled"
            elif last_status is None:
                status = "idle"
            elif last_status == "error":
                status = "error"
            elif last_status == "degraded":
                status = "degraded"
            else:
                status = "healthy"
            out.append(SourceStatus(
                id=sid, meta=meta.model_dump(), enabled=enabled, disabled_reason=reason, status=status,
                last_attempt=last_attempt, last_success=last_ok, last_error=last_err if status == "error" else None,
                data_time=data_time, data_age_s=(now - data_time).total_seconds() if data_time else None,
                latency_ms_p50=round(p50, 1) if p50 is not None else None, stored_records=int(counts.get(sid, 0)),
                runs_24h=int(n24 or 0), errors_24h=int(e24 or 0), bytes_24h=int(b24 or 0),
                jobs=[j for j in jobs if j["group"] == sid], recent_runs=runs.get(sid, []),
            ))  # fmt: skip
        return out
