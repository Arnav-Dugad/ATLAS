"""HTTP API v1."""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta
from typing import Annotated, Any

import orjson
from fastapi import APIRouter, HTTPException, Query, Request, Response
from sse_starlette.sse import EventSourceResponse

from atlas import __version__
from atlas.api.schemas import (
    Columnar,
    IncidentDetail,
    IncidentList,
    Overview,
    SourceStatus,
)
from atlas.api.service import QueryService
from atlas.engine import context as context_engine
from atlas.engine import exposure
from atlas.engine import query as query_engine
from atlas.engine.fires import fire_grid
from atlas.http.client import FetchError
from atlas.models import Hazard
from atlas.observability import log_buffer, metrics
from atlas.runtime import Runtime
from atlas.util.timeutil import iso_z, parse_iso, utcnow

router = APIRouter(prefix="/api/v1")


def json_bytes(payload: Any, *, cache_s: int = 0) -> Response:
    """Serialise large untyped payloads with orjson (several times faster than stdlib json)."""
    headers = {"Cache-Control": f"public, max-age={cache_s}"} if cache_s else None
    return Response(orjson.dumps(payload), media_type="application/json", headers=headers)


def rt(request: Request) -> Runtime:
    return request.app.state.runtime  # type: ignore[no-any-return]


def svc(request: Request) -> QueryService:
    return request.app.state.service  # type: ignore[no-any-return]


def _csv(value: str | None) -> list[str] | None:
    if not value:
        return None
    return [v.strip() for v in value.split(",") if v.strip()]


def _bbox(value: str | None) -> list[float] | None:
    if not value:
        return None
    try:
        parts = [float(v) for v in value.split(",")]
    except ValueError as exc:
        raise HTTPException(400, "bbox must be west,south,east,north") from exc
    if len(parts) != 4 or not (-180 <= parts[0] <= 180 and -90 <= parts[1] <= parts[3] <= 90 and -180 <= parts[2] <= 180):
        raise HTTPException(400, "bbox must be west,south,east,north in degrees")
    return parts


def _time(value: str | None, name: str) -> datetime | None:
    if value is None:
        return None
    dt = parse_iso(value)
    if dt is None:
        raise HTTPException(400, f"{name} must be an ISO-8601 timestamp")
    return dt


# --------------------------------------------------------------------------- meta / health
@router.get("/meta")
def meta(request: Request) -> dict[str, Any]:
    r = rt(request)
    return {
        "name": "ATLAS",
        "version": __version__,
        "started_at": iso_z(r.started_at),
        "now": iso_z(utcnow()),
        "offline": r.settings.offline,
        "registry_verified_at": r.registry.verified_at,
        "duckdb_extensions": r.db.extensions,
        "geocoder": r.geocoder.available,
        "packs": r.packs.status(),
        "connectors": {k: {"enabled": v[0], "reason": v[1]} for k, v in r.availability().items()},
        "attribution": [s.attribution for s in r.registry.sources.values() if s.default_enabled],
    }


@router.get("/health")
def health(request: Request) -> dict[str, Any]:
    r = rt(request)
    jobs = [j.snapshot() for j in r.scheduler.jobs.values()]
    failing = [j for j in jobs if j["failures"]]
    return {
        "status": "degraded" if failing else "ok",
        "uptime_s": round((utcnow() - r.started_at).total_seconds()),
        "jobs": jobs,
        "stream_subscribers": r.bus.subscriber_count,
    }


@router.get("/metrics")
def metrics_view(request: Request, logs: int = 200) -> dict[str, Any]:
    r = rt(request)
    return {
        **metrics.snapshot(),
        "db_bytes": r.db.size_bytes(),
        "cache_bytes": r.cache.total_bytes(),
        "logs": list(log_buffer.records)[-max(0, min(logs, 1000)) :],
    }


# --------------------------------------------------------------------------------- incidents
@router.get("/overview", response_model=Overview)
def overview(request: Request) -> Overview:
    s = svc(request)
    return s.overview(s.sources())


@router.get("/incidents", response_model=IncidentList)
def incidents(
    request: Request,
    status: str | None = "active,monitoring",
    hazard: str | None = None,
    min_severity: Annotated[int, Query(ge=0, le=5)] = 0,
    q: Annotated[str | None, Query(max_length=120)] = None,
    bbox: str | None = None,
    since: str | None = None,
    until: str | None = None,
    country: Annotated[str | None, Query(max_length=3)] = None,
    sort: str = "severity",
    limit: Annotated[int, Query(ge=1, le=1000)] = 300,
) -> IncidentList:
    items, total = svc(request).list_incidents(
        status=_csv(status), hazards=_csv(hazard), min_severity=min_severity, q=q, bbox=_bbox(bbox),
        since=_time(since, "since"), until=_time(until, "until"), country=country, sort=sort, limit=limit,
    )  # fmt: skip
    return IncidentList(items=items, total=total, generated_at=utcnow())


@router.get("/incidents/{incident_id}", response_model=IncidentDetail)
def incident(request: Request, incident_id: str) -> IncidentDetail:
    detail = svc(request).get_incident(incident_id)
    if detail is None:
        raise HTTPException(404, "incident not found")
    return detail


@router.get("/incidents/{incident_id}/weather")
async def incident_weather(request: Request, incident_id: str) -> dict[str, Any]:
    r = rt(request)
    with r.db.read() as cur:
        row = cur.execute("SELECT lat, lon FROM incidents WHERE id = ?", [incident_id]).fetchone()
    if row is None or row[0] is None:
        raise HTTPException(404, "incident not found or has no location")
    try:
        return await context_engine.weather(r.http, row[0], row[1])
    except FetchError as exc:
        raise HTTPException(503, {"code": "source_unavailable", "source": "open-meteo", "message": str(exc)}) from exc


def _incident_point(r: Runtime, incident_id: str) -> tuple[Hazard, float, float]:
    with r.db.read() as cur:
        row = cur.execute("SELECT hazard, lat, lon FROM incidents WHERE id = ?", [incident_id]).fetchone()
    if row is None or row[1] is None:
        raise HTTPException(404, "incident not found or has no location")
    return Hazard(row[0]), float(row[1]), float(row[2])


@router.get("/incidents/{incident_id}/exposure/population")
async def incident_population(request: Request, incident_id: str) -> dict[str, Any]:
    """People living within distance rings (GHSL 2025). Milliseconds; requires the Population Pack."""
    r = rt(request)
    hazard, lat, lon = _incident_point(r, incident_id)
    return await asyncio.to_thread(exposure.population_exposure, r.population, hazard, lat, lon)


@router.get("/incidents/{incident_id}/exposure/infrastructure")
async def incident_infrastructure(request: Request, incident_id: str) -> dict[str, Any]:
    """Mapped facilities within distance rings (OpenStreetMap via Overpass; cached 24 h)."""
    r = rt(request)
    hazard, lat, lon = _incident_point(r, incident_id)
    return await exposure.infrastructure_exposure(r.http, hazard, lat, lon)


@router.post("/packs/reload")
async def packs_reload(request: Request) -> dict[str, Any]:
    """Re-open optional packs after installation and recompute open incidents."""
    r = rt(request)
    available = r.reload_population()
    if available:
        await asyncio.to_thread(r.pipeline.sweep)
    return {"population": available, "packs": r.packs.status()}


@router.get("/incidents/{incident_id}/knowledge")
def incident_knowledge(request: Request, incident_id: str, at: str | None = None) -> dict[str, Any]:
    """Data Time Machine: what ATLAS knew about this incident at a past instant."""
    when = _time(at, "at") or utcnow()
    with rt(request).db.read() as cur:
        rows = cur.execute(
            """
            SELECT v.observation_id, o.source, v.version, v.recorded_at, v.source_updated_at, v.lat, v.lon, v.depth_km,
                   v.magnitude, v.alert_level, v.status, v.metrics
            FROM observation_versions v JOIN observations o ON o.id = v.observation_id
            WHERE o.incident_id = ? AND v.recorded_at <= ?
            QUALIFY row_number() OVER (PARTITION BY v.observation_id ORDER BY v.version DESC) = 1
            ORDER BY v.recorded_at
            """,
            [incident_id, when],
        ).fetchall()
        changes = cur.execute(
            "SELECT changed_at, kind, summary, significance, source FROM incident_changes WHERE incident_id = ? AND changed_at <= ? ORDER BY changed_at",
            [incident_id, when],
        ).fetchall()
    return {
        "incident_id": incident_id,
        "as_of": iso_z(when),
        "observations": [
            {
                "observation_id": r[0],
                "source": r[1],
                "version": r[2],
                "recorded_at": iso_z(r[3]),
                "source_updated_at": iso_z(r[4]),
                "lat": r[5],
                "lon": r[6],
                "depth_km": r[7],
                "magnitude": r[8],
                "alert_level": r[9],
                "status": r[10],
                "metrics": orjson.loads(r[11]) if r[11] else {},
            }  # fmt: skip
            for r in rows
        ],
        "changes": [{"at": iso_z(c[0]), "kind": c[1], "summary": c[2], "significance": c[3], "source": c[4]} for c in changes],
        "note": "Reconstructed from ATLAS's append-only observation history; reflects what this ATLAS instance had ingested at that time.",
    }


@router.get("/changes")
def changes(
    request: Request, since: str | None = None, min_significance: int = 1, limit: Annotated[int, Query(le=500)] = 100
) -> dict[str, Any]:
    start = _time(since, "since") or utcnow() - timedelta(days=2)
    with rt(request).db.read() as cur:
        rows = cur.execute(
            "SELECT c.id, c.incident_id, c.changed_at, c.kind, c.summary, c.significance, c.source, i.title, i.hazard, i.severity_level "
            "FROM incident_changes c JOIN incidents i ON i.id = c.incident_id "
            "WHERE c.changed_at >= ? AND c.significance >= ? ORDER BY c.changed_at DESC, c.id DESC LIMIT ?",
            [start, min_significance, limit],
        ).fetchall()
    return {
        "items": [
            {
                "id": r[0],
                "incident_id": r[1],
                "at": iso_z(r[2]),
                "kind": r[3],
                "summary": r[4],
                "significance": r[5],
                "source": r[6],
                "incident_title": r[7],
                "hazard": r[8],
                "severity_level": r[9],
            }  # fmt: skip
            for r in rows
        ]
    }


# ------------------------------------------------------------------------------------ layers
@router.get("/layers/earthquakes", response_model=Columnar)
def layer_earthquakes(
    request: Request, hours: Annotated[int, Query(ge=1, le=24 * 30)] = 24 * 7, min_mag: float = 0.0,
) -> Columnar:  # fmt: skip
    start = utcnow() - timedelta(hours=hours)
    with rt(request).db.read() as cur:
        rows = cur.execute(
            "SELECT external_id, lat, lon, depth_km, magnitude, epoch_ms(event_time), alert_level, incident_id, "
            "CAST(json_extract(metrics, '$.sig') AS INTEGER), CAST(json_extract(metrics, '$.tsunami') AS BOOLEAN), status "
            "FROM observations WHERE source = 'usgs' AND NOT retracted AND event_time >= ? AND coalesce(magnitude, 0) >= ? "
            "ORDER BY event_time",
            [start, min_mag],
        ).fetchall()
    cols = ["id", "lat", "lon", "depth", "mag", "t", "alert", "incident", "sig", "tsunami", "status"]
    return Columnar(count=len(rows), columns={c: [r[i] for r in rows] for i, c in enumerate(cols)}, generated_at=utcnow(),
                    attribution=["Earthquake data: U.S. Geological Survey (USGS)"])  # fmt: skip


@router.get("/layers/fires/grid", response_model=Columnar)
def layer_fire_grid(
    request: Request, res: Annotated[int, Query(ge=2, le=7)] = 4, hours: Annotated[int, Query(ge=1, le=48)] = 48
) -> Columnar:
    cells = fire_grid(rt(request).db, res, utcnow() - timedelta(hours=hours))
    cols = ["cell", "lat", "lon", "count", "frp", "latest", "high"]
    data = {c: [x[c] for x in cells] for c in cols}
    data["latest"] = [int(v.timestamp() * 1000) if isinstance(v, datetime) else None for v in data["latest"]]
    return Columnar(count=len(cells), columns=data, generated_at=utcnow(),
                    attribution=["NASA LANCE FIRMS (VIIRS/MODIS); aggregated to H3 by ATLAS"],
                    note=f"H3 resolution {res}; counts are detections, not fires")  # fmt: skip


@router.get("/layers/fires/detections", response_model=Columnar)
def layer_fire_points(
    request: Request, bbox: str | None = None, hours: Annotated[int, Query(ge=1, le=48)] = 48,
    limit: Annotated[int, Query(ge=1, le=300_000)] = 120_000,
) -> Columnar:  # fmt: skip
    box = _bbox(bbox)
    where, params = ["acq_time >= ?"], [utcnow() - timedelta(hours=hours)]
    if box:
        w, s, e, n = box
        where.append("lat BETWEEN ? AND ?")
        params += [s, n]
        if w <= e:
            where.append("lon BETWEEN ? AND ?")
            params += [w, e]
        else:
            where.append("(lon >= ? OR lon <= ?)")
            params += [w, e]
    with rt(request).db.read() as cur:
        rows = cur.execute(
            f"SELECT round(lat, 4), round(lon, 4), round(coalesce(frp, 0), 1), epoch_ms(acq_time), confidence, satellite, daynight "
            f"FROM fire_detections WHERE {' AND '.join(where)} ORDER BY acq_time LIMIT ?",
            [*params, limit],
        ).fetchall()
    cols = ["lat", "lon", "frp", "t", "conf", "sat", "dn"]
    return Columnar(count=len(rows), columns={c: [r[i] for r in rows] for i, c in enumerate(cols)}, generated_at=utcnow(),
                    attribution=["NASA LANCE FIRMS (VIIRS 375 m, MODIS 1 km)"])  # fmt: skip


@router.get("/layers/fires/clusters")
def layer_fire_clusters(request: Request, min_detections: Annotated[int, Query(ge=10)] = 25) -> Response:
    with rt(request).db.read() as cur:
        rows = cur.execute(
            "SELECT id, lat, lon, hull, detections, footprint_km2, frp_total, frp_max, first_seen, last_seen, recent_12h, prior_12h, static_suspect "
            "FROM fire_clusters WHERE detections >= ? ORDER BY frp_total DESC",
            [min_detections],
        ).fetchall()
    return json_bytes(
        {
            "type": "FeatureCollection",
            "features": [
                {
                    "type": "Feature",
                    "geometry": orjson.loads(r[3]) if r[3] else None,
                    "properties": {
                        "id": r[0],
                        "lat": r[1],
                        "lon": r[2],
                        "detections": r[4],
                        "footprint_km2": r[5],
                        "frp_total": r[6],
                        "frp_max": r[7],
                        "first_seen": iso_z(r[8]),
                        "last_seen": iso_z(r[9]),
                        "recent_12h": r[10],
                        "prior_12h": r[11],
                        "static_suspect": r[12],
                    },
                }  # fmt: skip
                for r in rows
            ],
            "attribution": ["NASA LANCE FIRMS; clusters derived by ATLAS (H3 r7 connectivity)"],
        }
    )


@router.get("/geo/countries")
def countries(request: Request, response: Response, res: str = "110m") -> Response:
    name = "countries_110m.geojson" if res == "110m" else "countries_50m.geojson"
    path = rt(request).packs.file("core", name)
    if path is None:
        raise HTTPException(503, {"code": "pack_missing", "message": "Core Pack not installed. Run `atlas setup`."})
    data = orjson.loads(path.read_bytes())
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
    return Response(orjson.dumps(slim), media_type="application/geo+json", headers={"Cache-Control": "public, max-age=86400"})


# ------------------------------------------------------------------------------------ search
@router.get("/search")
async def search(request: Request, q: Annotated[str, Query(min_length=1, max_length=200)]) -> dict[str, Any]:
    r = rt(request)
    now = utcnow()
    parsed = query_engine.parse(q, r.geocoder, now, population_available=r.population is not None)
    places = r.geocoder.search(q, limit=6)
    countries = r.geocoder.search_countries(q, limit=3)
    s = svc(request)
    incident_hits, _ = s.list_incidents(status=None, hazards=None, min_severity=0, q=q, bbox=None, since=None, until=None,
                                        country=None, sort="recent", limit=8)  # fmt: skip
    structured: dict[str, Any] = {"parsed": parsed.to_dict(), "results": [], "archive": None}
    if parsed.is_structured:
        bbox = None
        if parsed.place and parsed.place.get("kind") == "place":
            from atlas.util.geo import bbox_around

            bbox = list(bbox_around(parsed.place["lat"], parsed.place["lon"], parsed.place.get("radius_km", 300)))
        items, total = s.list_incidents(status=parsed.status, hazards=parsed.hazards or None, min_severity=0, q=None, bbox=bbox,
                                        since=parsed.start, until=parsed.end, country=parsed.country_iso3, sort=parsed.sort, limit=50)  # fmt: skip
        if parsed.min_magnitude is not None:
            items = [
                i
                for i in items
                if any(
                    m.key == "magnitude" and isinstance(m.value, (int, float)) and m.value >= parsed.min_magnitude
                    for m in i.headline
                )
            ]
        if parsed.min_population is not None:
            items = [
                i
                for i in items
                if any(
                    m.key == "population_ring" and isinstance(m.value, (int, float)) and m.value >= parsed.min_population
                    for m in i.headline
                )
            ]
        structured["results"] = [i.model_dump(mode="json") for i in items]
        structured["total"] = total
        if parsed.needs_archive and parsed.hazards == ["earthquake"]:
            structured["archive"] = await _archive_earthquakes(r, parsed)
    meta_hits = [
        {"kind": "source", "id": m.id, "name": m.name, "provider": m.provider}
        for m in r.registry.sources.values()
        if q.lower() in m.name.lower() or q.lower() in m.provider.lower() or q.lower() == m.id
    ][:4]
    return {
        "query": q,
        "places": places,
        "countries": countries,
        "incidents": [i.model_dump(mode="json") for i in incident_hits],
        "sources": meta_hits,
        "structured": structured,
    }


async def _archive_earthquakes(r: Runtime, parsed: query_engine.ParsedQuery) -> dict[str, Any]:
    """Query the USGS ComCat archive live (cached 6 h) for windows older than the local store."""
    filters: dict[str, object] = {"min_magnitude": parsed.min_magnitude or 5.0, "limit": 2000}
    if parsed.place and parsed.place.get("bbox"):
        filters["bbox"] = parsed.place["bbox"]
    try:
        out = await r.connectors["usgs"].fetch_historical(parsed.start, parsed.end or utcnow(), **filters)  # type: ignore[arg-type]
    except (FetchError, NotImplementedError) as exc:
        return {"status": "unavailable", "message": str(exc)}
    events = out.observations
    if parsed.country_iso3:
        events = [
            o
            for o in events
            if o.lat is not None and (hit := r.geocoder.country(o.lat, o.lon)) and hit.iso3 == parsed.country_iso3
        ]  # type: ignore[arg-type]
    events.sort(key=lambda o: -(o.magnitude or 0))
    for o in events:
        # Some ComCat place strings carry '?' where a non-ASCII letter was lost upstream
        # (e.g. "?arai" for Ōarai). Substitute ATLAS's own offline place description.
        if "?" in o.title and o.lat is not None and o.lon is not None:
            place = r.geocoder.describe(o.lat, o.lon)
            if place and o.magnitude is not None:
                o.title = f"M{o.magnitude:.1f} earthquake — {place.description} (place derived by ATLAS)"
    return {
        "status": "ok",
        "source": "usgs",
        "attribution": "Earthquake data: U.S. Geological Survey (USGS) ComCat",
        "count": len(events),
        "from_cache": out.from_cache,
        "events": [
            {
                "id": o.external_id,
                "title": o.title,
                "lat": o.lat,
                "lon": o.lon,
                "depth_km": o.depth_km,
                "magnitude": o.magnitude,
                "time": iso_z(o.event_time),
                "alert": o.alert_level,
                "url": o.url,
                "tsunami": o.metrics.get("tsunami"),
            }  # fmt: skip
            for o in events[:300]
        ],
    }


# ----------------------------------------------------------------------------------- sources
@router.get("/sources", response_model=list[SourceStatus])
def sources(request: Request) -> list[SourceStatus]:
    return svc(request).sources(with_runs=False)


@router.get("/sources/{source_id}", response_model=SourceStatus)
def source(request: Request, source_id: str) -> SourceStatus:
    found = svc(request).sources(with_runs=True, only=source_id)
    if not found:
        raise HTTPException(404, "unknown source")
    return found[0]


@router.post("/sources/{source_id}/sync")
def source_sync(request: Request, source_id: str) -> dict[str, Any]:
    r = rt(request)
    if source_id not in r.connectors:
        raise HTTPException(404, "unknown connector")
    ok, why = r.availability()[source_id]
    if not ok:
        raise HTTPException(409, {"code": "disabled", "message": why})
    fired = r.scheduler.trigger_group(source_id)
    return {"triggered": fired, "note": "Manual refresh is rate-limited to once per 30 s per job."}


# ----------------------------------------------------------------------------------- storage
@router.get("/storage")
def storage(request: Request) -> dict[str, Any]:
    r = rt(request)
    entries = r.cache.entries()
    by_source: dict[str, dict[str, int]] = {}
    for e in entries:
        b = by_source.setdefault(e.source_id or "other", {"entries": 0, "bytes": 0})
        b["entries"] += 1
        b["bytes"] += e.size
    with r.db.read() as cur:
        tables = {
            t: int(cur.execute(f"SELECT count(*) FROM {t}").fetchone()[0])  # type: ignore[index]
            for t in (
                "observations",
                "observation_versions",
                "incidents",
                "incident_changes",
                "fire_detections",
                "fire_clusters",
                "sync_runs",
            )
        }
    return {
        "database": {"path": r.db.path, "bytes": r.db.size_bytes(), "tables": tables},
        "http_cache": {"bytes": r.cache.total_bytes(), "entries": len(entries), "by_source": by_source},
        "packs": r.packs.status(),
    }


@router.post("/storage/cache/clear")
def clear_cache(request: Request, source: str | None = None) -> dict[str, Any]:
    removed = rt(request).cache.clear(source)
    return {"removed": removed}


# ------------------------------------------------------------------------------------ stream
@router.get("/stream")
async def stream(request: Request) -> EventSourceResponse:
    r = rt(request)
    queue = r.bus.subscribe()

    async def gen():  # type: ignore[no-untyped-def]
        try:
            yield {"event": "hello", "data": orjson.dumps({"version": __version__, "at": iso_z(utcnow())}).decode()}
            while True:
                if await request.is_disconnected():
                    break
                try:
                    ev = await asyncio.wait_for(queue.get(), timeout=15)
                except TimeoutError:
                    yield {"event": "ping", "data": iso_z(utcnow())}
                    continue
                yield {"event": ev["kind"], "id": str(ev["id"]), "data": orjson.dumps(ev).decode()}
        finally:
            r.bus.unsubscribe(queue)

    return EventSourceResponse(gen(), ping=None, headers={"X-Accel-Buffering": "no"})
