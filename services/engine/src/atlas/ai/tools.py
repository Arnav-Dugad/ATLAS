"""Typed, read-only tools the local assistant may call.

Each tool has a strict argument model (unknown fields rejected, every value bounded), reads
ATLAS's own store or a fixed public archive, and returns compact JSON. There is deliberately
no tool that writes, deletes, runs commands, fetches arbitrary URLs or reads files: text in a
feed that "asks" the model to do something has nothing it could do it with.
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import timedelta
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from atlas.ai.docs_index import DocsIndex
from atlas.api.schemas import IncidentSummary
from atlas.api.service import QueryService
from atlas.runtime import Runtime
from atlas.util.timeutil import iso_z, utcnow

HazardName = Literal["earthquake", "tropical_cyclone", "wildfire", "flood", "volcano", "drought", "severe_storm"]
INCIDENT_ID = r"^ATL-[A-Z]{2}-\d{4}-[A-Z0-9]{8}$"
_CTRL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f​-‏ -‮⁦-⁩]")


def clean(text: object, limit: int = 240) -> str:
    """Untrusted feed text → plain, bounded string (no control or bidi characters)."""
    s = unicodedata.normalize("NFKC", str(text or ""))
    s = _CTRL.sub(" ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s if len(s) <= limit else s[: limit - 1] + "…"


class _Args(BaseModel):
    model_config = ConfigDict(extra="forbid")


class SearchIncidentsArgs(_Args):
    hazard: list[HazardName] | None = Field(None, description="Restrict to these hazard types")
    status: Literal["open", "active", "any"] = Field("open", description="open = active or monitoring")
    min_severity: int = Field(0, ge=0, le=5, description="ATLAS severity 0–5")
    country: str | None = Field(None, max_length=60, description="Country name or ISO3 code")
    text: str | None = Field(None, max_length=80, description="Words in the incident title, e.g. a volcano or storm name")
    since_days: int = Field(30, ge=1, le=60, description="Only incidents with data in the last N days")
    sort: Literal["severity", "recent"] = "severity"
    limit: int = Field(10, ge=1, le=20)


class IncidentIdArgs(_Args):
    id: str = Field(..., pattern=INCIDENT_ID, description="ATLAS incident id, e.g. ATL-EQ-2026-ABCD1234")


class NoArgs(_Args):
    pass


class RecentChangesArgs(_Args):
    hours: int = Field(24, ge=1, le=72)
    min_significance: int = Field(2, ge=1, le=3)
    limit: int = Field(12, ge=1, le=20)


class ArchiveArgs(_Args):
    min_magnitude: float = Field(6.0, ge=4.0, le=9.5)
    country: str | None = Field(None, max_length=60, description="Country name or ISO3 code (optional)")
    start_year: int = Field(..., ge=1900, le=2100)
    end_year: int = Field(..., ge=1900, le=2100)
    limit: int = Field(15, ge=1, le=25)


class DocsArgs(_Args):
    query: str = Field(..., min_length=2, max_length=120)


@dataclass
class Citations:
    incidents: dict[str, dict[str, Any]] = field(default_factory=dict)
    sources: set[str] = field(default_factory=set)
    docs: list[dict[str, str]] = field(default_factory=list)

    def incident(self, s: IncidentSummary) -> None:
        self.incidents[s.id] = {"id": s.id, "title": clean(s.title, 120), "hazard": s.hazard, "lat": s.lat, "lon": s.lon}
        self.sources.update(s.sources)


@dataclass
class ToolContext:
    rt: Runtime
    svc: QueryService
    docs: DocsIndex
    cites: Citations


@dataclass(frozen=True)
class Tool:
    name: str
    description: str
    args: type[_Args]
    run: Callable[[ToolContext, Any], Awaitable[dict[str, Any]]]

    def schema(self) -> dict[str, Any]:
        params = self.args.model_json_schema()
        params.pop("title", None)
        for prop in (params.get("properties") or {}).values():
            prop.pop("title", None)
        return {"type": "function", "function": {"name": self.name, "description": self.description, "parameters": params}}


def _metric(m: Any) -> dict[str, Any]:
    return {
        "label": clean(m.label, 60),
        "value": m.value if isinstance(m.value, int | float | bool) or m.value is None else clean(m.value, 80),
        "unit": m.unit,
        "provenance": str(getattr(m.provenance, "value", m.provenance)),
        "source": m.source,
    }


def _summary(s: IncidentSummary) -> dict[str, Any]:
    return {
        "id": s.id,
        "title": clean(s.title, 140),
        "hazard": s.hazard,
        "status": s.status,
        "severity": f"{s.severity.level} {s.severity.label}",
        "confidence": s.confidence.label,
        "place": clean(s.place.description, 120) if s.place else None,
        "country": s.country_name,
        "started_at": iso_z(s.started_at),
        "last_data_at": iso_z(s.last_observation_at),
        "sources": s.sources,
        "key_metrics": [_metric(m) for m in s.headline[:3]],
    }


def _country(ctx: ToolContext, name: str | None) -> tuple[str | None, str | None]:
    if not name:
        return None, None
    if re.fullmatch(r"[A-Za-z]{3}", name):
        iso = name.upper()
        return iso, ctx.rt.geocoder.country_name(iso) or iso
    hits = ctx.rt.geocoder.search_countries(name, limit=1)
    if hits:
        return str(hits[0]["iso3"]), str(hits[0]["name"])
    return None, None


async def search_incidents(ctx: ToolContext, a: SearchIncidentsArgs) -> dict[str, Any]:
    iso, cname = _country(ctx, a.country)
    if a.country and not iso:
        return {"error": f"Unknown country: {clean(a.country, 60)}"}
    status = {"open": ["active", "monitoring"], "active": ["active"], "any": None}[a.status]
    items, total = ctx.svc.list_incidents(
        status=status, hazards=a.hazard, min_severity=a.min_severity, q=a.text, bbox=None,
        since=utcnow() - timedelta(days=a.since_days), until=None, country=iso, sort=a.sort, limit=a.limit,
    )  # fmt: skip
    for s in items:
        ctx.cites.incident(s)
    return {
        "total_matching": total,
        "returned": len(items),
        "filters": {
            "hazard": a.hazard,
            "status": a.status,
            "min_severity": a.min_severity,
            "country": cname,
            "since_days": a.since_days,
        },
        "incidents": [_summary(s) for s in items],
    }


async def get_incident(ctx: ToolContext, a: IncidentIdArgs) -> dict[str, Any]:
    d = ctx.svc.get_incident(a.id)
    if d is None:
        return {"error": f"No incident {a.id}"}
    ctx.cites.incident(d)
    return {
        **_summary(d),
        "severity_basis": clean(d.severity.basis, 300),
        "severity_method": d.severity.method,
        "confidence_score": round(d.confidence.score, 2),
        "metrics": [_metric(m) for m in d.headline],
        "observations": [
            {
                "source": o.source,
                "title": clean(o.title, 120),
                "magnitude": o.magnitude,
                "alert": o.alert_level,
                "updated_at": iso_z(o.source_updated_at),
            }
            for o in d.observations[:8]
        ],
        "recent_changes": [{"at": iso_z(c.at), "summary": clean(c.summary, 160)} for c in d.changes[-8:]],
        "official_links": [
            {"authority": clean(link.authority, 60), "label": clean(link.label, 80), "url": link.url}
            for link in d.official_links[:5]
        ],
        "related": [
            {"id": r.id, "title": clean(r.title, 100), "relation": r.relation, "distance_km": round(r.distance_km)}
            for r in d.related[:5]
        ],
        "limitations": [clean(x, 200) for x in d.limitations[:4]],
    }


async def population_exposure(ctx: ToolContext, a: IncidentIdArgs) -> dict[str, Any]:
    import asyncio

    from atlas.engine import exposure
    from atlas.models import Hazard

    if ctx.rt.population is None:
        return {"unavailable": "The optional Population Pack is not installed."}
    with ctx.rt.db.read() as cur:
        row = cur.execute("SELECT hazard, lat, lon FROM incidents WHERE id = ?", [a.id]).fetchone()
    if row is None or row[1] is None:
        return {"error": f"No incident {a.id} with a location"}
    out = await asyncio.to_thread(exposure.population_exposure, ctx.rt.population, Hazard(row[0]), row[1], row[2])
    return {
        "provenance": "model",
        "meaning": "Residents (GHSL 2025 model) whose grid cell centre lies within each distance of the incident position. Not people affected.",
        "rings": out.get("rings"),
        "dataset": out.get("dataset"),
    }


async def planet_overview(ctx: ToolContext, _a: NoArgs) -> dict[str, Any]:
    ov = ctx.svc.overview(ctx.svc.sources())
    return {
        "generated_at": iso_z(ov.generated_at),
        "active_incidents": ov.incidents_active,
        "monitoring_incidents": ov.incidents_monitoring,
        "by_hazard": [{"hazard": h.hazard, "active": h.active, "monitoring": h.monitoring} for h in ov.by_hazard],
        "severity_histogram_active": ov.severity_histogram,
        "earthquakes_m2_5_last_24h": ov.earthquakes_24h,
        "largest_earthquake_last_24h": ov.earthquakes_24h_max_mag,
        "fire_detections_last_24h": ov.fire_detections_24h,
        "active_cyclones": ov.active_cyclones,
    }


async def recent_changes(ctx: ToolContext, a: RecentChangesArgs) -> dict[str, Any]:
    since = utcnow() - timedelta(hours=a.hours)
    with ctx.rt.db.read() as cur:
        rows = cur.execute(
            "SELECT c.incident_id, c.changed_at, c.summary, c.significance, i.title FROM incident_changes c "
            "JOIN incidents i ON i.id = c.incident_id WHERE c.changed_at >= ? AND c.significance >= ? "
            "ORDER BY c.significance DESC, c.changed_at DESC LIMIT ?",
            [since, a.min_significance, a.limit],
        ).fetchall()
    for r in rows:
        ctx.cites.incidents.setdefault(r[0], {"id": r[0], "title": clean(r[4], 120), "hazard": None, "lat": None, "lon": None})
    return {
        "changes": [
            {
                "incident_id": r[0],
                "incident": clean(r[4], 100),
                "at": iso_z(r[1]),
                "summary": clean(r[2], 160),
                "significance": r[3],
            }
            for r in rows
        ]
    }


async def earthquake_archive(ctx: ToolContext, a: ArchiveArgs) -> dict[str, Any]:
    from datetime import UTC, datetime

    if a.end_year < a.start_year:
        return {"error": "end_year is before start_year"}
    if a.end_year - a.start_year > 60:
        return {"error": "Ask for at most 60 years at a time"}
    iso, cname = _country(ctx, a.country)
    if a.country and not iso:
        return {"error": f"Unknown country: {clean(a.country, 60)}"}
    filters: dict[str, Any] = {"min_magnitude": a.min_magnitude, "limit": 2000}
    if iso:
        bbox = ctx.rt.geocoder.country_bbox(iso)
        if bbox:
            filters["bbox"] = bbox
    start = datetime(a.start_year, 1, 1, tzinfo=UTC)
    end = min(utcnow(), datetime(a.end_year, 12, 31, 23, 59, tzinfo=UTC))
    try:
        out = await ctx.rt.connectors["usgs"].fetch_historical(start, end, **filters)  # type: ignore[attr-defined]
    except Exception as exc:
        return {"error": f"USGS archive unavailable: {clean(exc, 120)}"}
    events = out.observations
    if iso:
        events = [o for o in events if o.lat is not None and (h := ctx.rt.geocoder.country(o.lat, o.lon)) and h.iso3 == iso]  # type: ignore[arg-type]
    events.sort(key=lambda o: -(o.magnitude or 0))
    ctx.cites.sources.add("usgs")
    return {
        "source": "USGS ComCat (archive)",
        "country": cname,
        "count": len(events),
        "largest": [
            {
                "time": iso_z(o.event_time),
                "magnitude": o.magnitude,
                "place": clean(o.title, 120),
                "depth_km": o.depth_km,
                "usgs_id": o.external_id,
            }
            for o in events[: a.limit]
        ],
    }


async def search_docs(ctx: ToolContext, a: DocsArgs) -> dict[str, Any]:
    hits = ctx.docs.search(a.query, k=3)
    for _score, sec in hits:
        ctx.cites.docs.append({"doc": sec.doc, "section": sec.heading})
    return {"passages": [{"doc": sec.doc, "section": sec.heading, "text": sec.text[:1100]} for _score, sec in hits]}


async def source_status(ctx: ToolContext, _a: NoArgs) -> dict[str, Any]:
    return {
        "sources": [
            {
                "id": s.id,
                "name": clean(s.meta.get("name"), 80),
                "status": s.status,
                "last_success": iso_z(s.last_success) if s.last_success else None,
                "licence": clean((s.meta.get("license") or {}).get("name"), 80),
            }
            for s in ctx.svc.sources()
        ]
    }


TOOLS: dict[str, Tool] = {
    t.name: t
    for t in (
        Tool("search_incidents", "Find current ATLAS incidents (earthquakes, cyclones, wildfires, floods, volcanoes…) by hazard, status, severity, country, title words and recency.", SearchIncidentsArgs, search_incidents),
        Tool("get_incident", "Full detail for one incident: metrics with provenance, severity basis, observations by source, recent changes, official links.", IncidentIdArgs, get_incident),
        Tool("population_exposure", "Modelled residents within 5/10/25/50 km of an incident (GHSL 2025). Model estimate, not people affected.", IncidentIdArgs, population_exposure),
        Tool("planet_overview", "Counts of active incidents by hazard and severity, and last-24-hour signals (earthquakes, fire detections, cyclones).", NoArgs, planet_overview),
        Tool("recent_changes", "Significant recent changes: new incidents, magnitude revisions, alert or intensity changes, fire growth.", RecentChangesArgs, recent_changes),
        Tool("earthquake_archive", "Historical earthquakes from the USGS ComCat archive by magnitude, country and year range (largest first).", ArchiveArgs, earthquake_archive),
        Tool("search_docs", "Search ATLAS's own documentation: how severity, confidence, exposure and satellite analyses are computed; data sources and licences.", DocsArgs, search_docs),
        Tool("source_status", "Health and licence of each data source ATLAS uses.", NoArgs, source_status),
    )
}  # fmt: skip


def schemas() -> list[dict[str, Any]]:
    return [t.schema() for t in TOOLS.values()]


async def call(ctx: ToolContext, name: str, raw_args: object) -> dict[str, Any]:
    """Validate and run one tool call; never raises (errors become data the model can read)."""
    tool = TOOLS.get(name)
    if tool is None:
        return {"error": f"Unknown tool '{clean(name, 40)}'. Available: {', '.join(TOOLS)}"}
    if isinstance(raw_args, str):
        import json

        try:
            raw_args = json.loads(raw_args or "{}")
        except json.JSONDecodeError:
            return {"error": "Arguments were not valid JSON"}
    if raw_args is None:
        raw_args = {}
    if not isinstance(raw_args, dict):
        return {"error": "Arguments must be an object"}
    try:
        args = tool.args.model_validate(raw_args)
    except ValidationError as exc:
        return {
            "error": "Invalid arguments",
            "details": [clean(f"{'.'.join(map(str, e['loc']))}: {e['msg']}", 120) for e in exc.errors()[:5]],
        }
    try:
        return await tool.run(ctx, args)
    except Exception as exc:
        return {"error": f"{name} failed: {clean(type(exc).__name__, 40)}"}
