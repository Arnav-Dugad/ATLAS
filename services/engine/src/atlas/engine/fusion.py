"""Incident fusion: turn the observations linked to one incident into one coherent record.

Precedence is explicit per hazard (the authoritative agency first). Every headline metric
names the source that supplied it and carries a provenance class.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

from atlas.engine import confidence as confidence_engine
from atlas.engine import severity as severity_engine
from atlas.engine.exposure import PopulationGrid
from atlas.engine.geocode import Geocoder
from atlas.engine.severity import current_wind
from atlas.models import (
    HAZARD_LABEL,
    Hazard,
    IncidentStatus,
    Metric,
    Observation,
    Provenance,
)
from atlas.registry import Registry
from atlas.store.repo import IncidentRecord, ObsRow
from atlas.util.geo import bbox_of
from atlas.util.timeutil import utcnow

PRIORITY: dict[Hazard, list[str]] = {
    Hazard.EARTHQUAKE: ["usgs", "gdacs", "eonet", "reliefweb"],
    Hazard.TROPICAL_CYCLONE: ["nhc", "gdacs", "eonet", "reliefweb"],
    Hazard.SEVERE_STORM: ["nhc", "eonet", "gdacs"],
    Hazard.WILDFIRE: ["firms", "gdacs", "eonet", "reliefweb"],
    Hazard.VOLCANO: ["gvp", "gdacs", "eonet", "reliefweb"],
    Hazard.FLOOD: ["gdacs", "eonet", "reliefweb"],
    Hazard.DROUGHT: ["gdacs", "eonet", "reliefweb"],
}

# How long after its newest data an incident of each hazard stays "active" / "monitoring"
# when no live snapshot vouches for it.
ACTIVE_WINDOW: dict[Hazard, timedelta] = {
    Hazard.EARTHQUAKE: timedelta(hours=72),
    Hazard.TROPICAL_CYCLONE: timedelta(hours=12),
    Hazard.WILDFIRE: timedelta(hours=24),
    Hazard.VOLCANO: timedelta(days=10),
    Hazard.FLOOD: timedelta(days=3),
    Hazard.DROUGHT: timedelta(days=30),
}
MONITOR_WINDOW: dict[Hazard, timedelta] = {
    Hazard.EARTHQUAKE: timedelta(days=14),
    Hazard.TROPICAL_CYCLONE: timedelta(days=3),
    Hazard.WILDFIRE: timedelta(days=5),
    Hazard.VOLCANO: timedelta(days=30),
    Hazard.FLOOD: timedelta(days=14),
    Hazard.DROUGHT: timedelta(days=90),
}
CLOSED_STATES = {"closed", "past", "deleted", "dissipated"}


@dataclass
class FusionContext:
    geocoder: Geocoder
    registry: Registry
    snapshots: dict[str, datetime]  # source -> time of its latest complete snapshot
    now: datetime
    population: PopulationGrid | None = None


# Reference ring for the headline "population within" metric. A descriptive distance, not an
# impact footprint; the full ring table is available per incident.
REFERENCE_RING_KM: dict[Hazard, float] = {
    Hazard.EARTHQUAKE: 25,
    Hazard.VOLCANO: 10,
    Hazard.WILDFIRE: 10,
    Hazard.TROPICAL_CYCLONE: 100,
    Hazard.SEVERE_STORM: 100,
    Hazard.LANDSLIDE: 10,
    Hazard.TSUNAMI: 25,
}


def _rank(hazard: Hazard, source: str) -> int:
    order = PRIORITY.get(hazard, [])
    return order.index(source) if source in order else len(order)


# Moving systems get fresh fixes every few hours; a storm whose newest position is older
# than this is treated as dissipated even if an aggregator has not closed it yet (EONET
# commonly keeps events open for days after the last advisory).
LIVE_DATA_MAX_AGE: dict[Hazard, timedelta] = {
    Hazard.TROPICAL_CYCLONE: timedelta(hours=24),
    Hazard.SEVERE_STORM: timedelta(hours=36),
}


def _is_live(row: ObsRow, ctx: FusionContext) -> bool:
    if row.retracted or (row.obs.status or "").lower() in CLOSED_STATES:
        return False
    snap = ctx.snapshots.get(row.obs.source)
    if snap is None:
        return False
    max_age = LIVE_DATA_MAX_AGE.get(row.obs.hazard)
    if max_age is not None:
        # For moving systems judge freshness by the newest *fix* (end_time = last track time for
        # GDACS), not by a feed's modification timestamp, which can change without new data.
        last_fix = row.obs.end_time or row.obs.source_updated_at or row.obs.event_time
        if ctx.now - last_fix > max_age:
            return False
    return row.last_seen_at >= snap - timedelta(minutes=2)


def fuse(incident_id: str, rows: Sequence[ObsRow], ctx: FusionContext, previous: IncidentRecord | None) -> IncidentRecord:
    obs = [r.obs for r in rows]
    hazard = _dominant_hazard(obs)
    ordered = sorted(
        rows, key=lambda r: (_rank(hazard, r.obs.source), -(r.obs.source_updated_at or r.obs.event_time).timestamp())
    )
    primary = ordered[0].obs
    located = [r.obs for r in ordered if r.obs.has_location()]

    # Position: storms move, so use the most recent fix from the most authoritative source.
    if hazard in (Hazard.TROPICAL_CYCLONE, Hazard.SEVERE_STORM) and located:
        best = min(located, key=lambda o: (_rank(hazard, o.source) if (ctx.now - (o.source_updated_at or o.event_time)) < timedelta(hours=8) else 50,
                                           -(o.source_updated_at or o.event_time).timestamp()))  # fmt: skip
        lat, lon = best.lat, best.lon
    elif located:
        lat, lon = located[0].lat, located[0].lon
    else:
        lat, lon = None, None

    started = min(o.event_time for o in obs)
    last_obs = max((o.source_updated_at or o.end_time or o.event_time) for o in obs)

    geocode_hit = ctx.geocoder.country(lat, lon) if lat is not None and lon is not None else None
    place = ctx.geocoder.describe(lat, lon) if lat is not None and lon is not None else None
    country_iso3 = (geocode_hit.iso3 if geocode_hit else None) or next((o.country_iso3 for o in obs if o.country_iso3), None)
    country_name = (geocode_hit.name if geocode_hit else None) or ctx.geocoder.country_name(country_iso3)

    status = _status(hazard, rows, ctx, started, last_obs)
    sev = severity_engine.assess(hazard, obs)
    conf = confidence_engine.assess(hazard, obs, ctx.registry, ctx.now, active=status == IncidentStatus.ACTIVE)

    geometry = _merge_geometry(obs)
    bbox = _bbox(obs, geometry)
    track = _merge_track(obs)
    if track:
        geometry = geometry or {"type": "FeatureCollection", "features": []}
        geometry["track"] = track

    title = _title(hazard, primary, obs, place, country_name, geocode_hit)
    headline = headline_metrics(hazard, obs)
    ring = REFERENCE_RING_KM.get(hazard)
    if ctx.population is not None and ring and lat is not None and lon is not None:
        pop = ctx.population.rings(lat, lon, [ring])[0]
        headline.append(
            Metric(
                key="population_ring", label=f"Population within {ring:g} km", value=round(pop, -2) if pop >= 1000 else round(pop),
                unit=None, provenance=Provenance.MODEL, source="ghsl-pop",
                method=f"GHSL 2025 30″ grid cells with centres within {ring:g} km of the incident position",
                note="Residential population living nearby — not the number of people affected",
            )
        )  # fmt: skip
    sources = sorted({o.source for o in obs}, key=lambda s: _rank(hazard, s))
    now = ctx.now
    ended = None if status != IncidentStatus.CLOSED else (previous.ended_at if previous and previous.ended_at else last_obs)
    place_dict = place.model_dump() if place else None
    if place_dict is not None and geocode_hit is not None:
        place_dict["offshore_km"] = geocode_hit.offshore_km
        place_dict["admin1"] = ctx.geocoder.admin1(lat, lon) if lat is not None and lon is not None else None
    return IncidentRecord(
        id=incident_id, hazard=hazard, title=title, status=status.value, lat=lat, lon=lon,
        bbox=list(bbox) if bbox else None, geometry=geometry, started_at=started, ended_at=ended,
        created_at=previous.created_at if previous else now, updated_at=now, last_observation_at=last_obs,
        severity_level=sev.level, severity=sev.model_dump(mode="json"), confidence=conf.model_dump(mode="json"),
        headline=[m.model_dump(mode="json") for m in headline], country_iso3=country_iso3,
        country_name=country_name, place=place_dict, source_count=len(sources), sources=sources,
        primary_observation=primary.id, revision=(previous.revision + 1) if previous else 1,
    )  # fmt: skip


def _dominant_hazard(obs: Sequence[Observation]) -> Hazard:
    hazards = [o.hazard for o in obs]
    if Hazard.TROPICAL_CYCLONE in hazards:
        return Hazard.TROPICAL_CYCLONE
    return max(set(hazards), key=hazards.count)


def _status(hazard: Hazard, rows: Sequence[ObsRow], ctx: FusionContext, started: datetime, last_obs: datetime) -> IncidentStatus:
    live = [r for r in rows if _is_live(r, ctx)]
    now = ctx.now
    if hazard is Hazard.EARTHQUAKE:
        window = ACTIVE_WINDOW[hazard]
        if any(r.obs.alert_level in ("orange", "red") for r in rows):
            window = timedelta(days=7)
        age = now - started
        if age <= window:
            return IncidentStatus.ACTIVE
        return IncidentStatus.MONITORING if age <= MONITOR_WINDOW[hazard] else IncidentStatus.CLOSED
    if live:
        return IncidentStatus.ACTIVE
    if hazard in LIVE_DATA_MAX_AGE:
        last_obs = max((r.obs.end_time or r.obs.source_updated_at or r.obs.event_time) for r in rows)
    age = now - last_obs
    if age <= ACTIVE_WINDOW.get(hazard, timedelta(days=2)) and not any(
        (r.obs.status or "").lower() in CLOSED_STATES for r in rows if r.obs.source in ctx.snapshots
    ):
        return IncidentStatus.ACTIVE
    return IncidentStatus.MONITORING if age <= MONITOR_WINDOW.get(hazard, timedelta(days=7)) else IncidentStatus.CLOSED


def _title(hazard: Hazard, primary: Observation, obs: Sequence[Observation], place: Any, country: str | None,
           hit: Any) -> str:  # fmt: skip
    where = place.description if place else (country or "")
    if hit is not None and hit.offshore_km > 0 and place is None and country:
        where = f"off the coast of {country}"
    if hazard is Hazard.EARTHQUAKE:
        mag = next((o.magnitude for o in obs if o.source == "usgs" and o.magnitude is not None),
                   next((o.magnitude for o in obs if o.magnitude is not None), None))  # fmt: skip
        return f"M{mag:.1f} earthquake — {where}" if mag is not None else f"Earthquake — {where}"
    if hazard is Hazard.TROPICAL_CYCLONE:
        nhc = next((o for o in obs if o.source == "nhc"), None)
        if nhc:
            return nhc.title
        gd = next((o for o in obs if o.source == "gdacs"), None)
        if gd and gd.names:
            name = gd.names[0].rsplit("-", 1)[0].title()
            return f"Tropical Cyclone {name}"
        return primary.title
    if hazard is Hazard.WILDFIRE:
        return f"Wildfire {place.description}" if place else f"Wildfire — {where}"
    if hazard is Hazard.VOLCANO:
        gvp = next((o for o in obs if o.source == "gvp"), None)
        return gvp.title if gvp else primary.title
    return primary.title


def headline_metrics(hazard: Hazard, obs: Sequence[Observation]) -> list[Metric]:
    by_src = {o.source: o for o in obs}
    out: list[Metric] = []

    def add(key: str, label: str, value: Any, unit: str | None, prov: Provenance, src: str | None,
            method: str | None = None, note: str | None = None, at: datetime | None = None) -> None:  # fmt: skip
        if value is None:
            return
        out.append(Metric(key=key, label=label, value=value, unit=unit, provenance=prov, source=src,
                          method=method, note=note, observed_at=at))  # fmt: skip

    if hazard is Hazard.EARTHQUAKE:
        u = by_src.get("usgs")
        g = by_src.get("gdacs")
        p = u or g
        if p:
            add("magnitude", "Magnitude", p.magnitude, p.magnitude_unit, Provenance.REAL, p.source, at=p.source_updated_at)
            add("depth", "Depth", round(p.depth_km, 1) if p.depth_km is not None else None, "km", Provenance.REAL, p.source)
        if u:
            add("review", "Solution", (u.status or "").capitalize() or None, None, Provenance.REAL, "usgs")
            add("pager", "PAGER alert", (u.alert_level or "").upper() or None, None, Provenance.MODEL, "usgs",
                method="USGS PAGER loss model", note="Estimated shaking-related fatalities/losses")  # fmt: skip
            add("mmi", "Max intensity (MMI)", u.metrics.get("mmi"), None, Provenance.MODEL, "usgs", method="USGS ShakeMap")
            add("felt", "Felt reports", u.metrics.get("felt"), None, Provenance.REAL, "usgs", method="Did You Feel It?")
            add("tsunami", "Tsunami flag", "Yes" if u.metrics.get("tsunami") else "No", None, Provenance.REAL, "usgs",
                note="USGS flag for oceanic regions; consult official tsunami warning centres")  # fmt: skip
            add("sig", "Significance", u.metrics.get("sig"), None, Provenance.DERIVED, "usgs", method="USGS significance index")
        if g:
            add("gdacs_alert", "GDACS alert", (g.alert_level or "").upper() or None, None, Provenance.MODEL, "gdacs",
                method="GDACS impact model")  # fmt: skip

    elif hazard in (Hazard.TROPICAL_CYCLONE, Hazard.SEVERE_STORM):
        n = by_src.get("nhc")
        g = by_src.get("gdacs")
        e = by_src.get("eonet")
        current = current_wind(obs)
        if current:
            wind, src = current
            fix = by_src[src]
            add("wind", "Max sustained wind", wind, "kt", Provenance.REAL, src, at=fix.source_updated_at,
                note="Latest advisory/fix intensity (1-minute sustained)")  # fmt: skip
            from atlas.connectors.nhc import saffir_simpson

            add("category", "Saffir–Simpson", saffir_simpson(wind), None, Provenance.DERIVED, src,
                method="Saffir–Simpson wind scale from the latest max sustained wind")  # fmt: skip
        if g and isinstance(g.metrics.get("peak_wind_kt"), (int, float)):
            add("peak_wind", "Lifetime peak wind", g.metrics.get("peak_wind_kt"), "kt", Provenance.REAL, "gdacs",
                note="Maximum wind over the storm's lifetime as reported by GDACS — not current intensity")  # fmt: skip
        if n:
            add("pressure", "Min central pressure", n.metrics.get("min_pressure_mb"), "mb", Provenance.REAL, "nhc")
            if n.metrics.get("movement_speed_mph") is not None:
                add("movement", "Movement", f"{n.metrics.get('movement_dir_deg'):.0f}° at {n.metrics.get('movement_speed_mph'):.0f} mph",
                    None, Provenance.REAL, "nhc")  # fmt: skip
            add("advisory", "Advisory", n.metrics.get("advisory_number"), None, Provenance.REAL, "nhc")
        if g:
            add("gdacs_alert", "GDACS alert", (g.alert_level or "").upper() or None, None, Provenance.MODEL, "gdacs",
                method="GDACS impact model (wind/storm surge exposure)")  # fmt: skip

    elif hazard is Hazard.WILDFIRE:
        agg = aggregate_fire_clusters(obs)
        if agg:
            n_clusters = agg["clusters"]
            add("detections", "Fire detections", agg["detections"], None, Provenance.DERIVED, "firms",
                method=f"VIIRS/MODIS detections in {n_clusters} ATLAS cluster{'s' if n_clusters > 1 else ''} (48 h window)")  # fmt: skip
            add("frp", "Σ Radiative power", agg["frp_total_mw"], "MW", Provenance.DERIVED, "firms",
                method="Sum of fire radiative power over the 48 h window")  # fmt: skip
            add("footprint", "Active footprint", agg["footprint_km2"], "km²", Provenance.DERIVED, "firms",
                method="Distinct H3 r9 cells with detections × mean cell area",
                note="Approximate area of detected burning pixels, not a burn perimeter")  # fmt: skip
            add("trend", "12 h trend", agg["trend"], None, Provenance.DERIVED, "firms",
                method="Detections in last 12 h vs preceding 12 h",
                note="Satellite overpass timing (day/night) influences short-term trends")  # fmt: skip
        g = by_src.get("gdacs")
        if g:
            add("burned", "Burned area", g.metrics.get("burned_area_ha"), "ha", Provenance.REAL, "gdacs",
                method="GWIS burned-area product")  # fmt: skip
            add("gdacs_alert", "GDACS alert", (g.alert_level or "").upper() or None, None, Provenance.MODEL, "gdacs")
        e = by_src.get("eonet")
        if e:
            add("eonet_area", "Reported size", e.metrics.get("area_acres"), "acres", Provenance.REAL, "eonet")

    elif hazard is Hazard.VOLCANO:
        v = by_src.get("gvp")
        if v:
            add("alert", "Observatory alert level", v.metrics.get("observatory_alert_level"), None, Provenance.REAL, "gvp")
            add("aviation", "Aviation colour code", v.metrics.get("aviation_color_code"), None, Provenance.REAL, "gvp")
            add("report", "Weekly report", v.metrics.get("report_kind"), None, Provenance.REAL, "gvp")
        g = by_src.get("gdacs")
        if g:
            add("gdacs_alert", "GDACS alert", (g.alert_level or "").upper() or None, None, Provenance.MODEL, "gdacs")

    else:
        g = by_src.get("gdacs")
        if g:
            add("gdacs_alert", "GDACS alert", (g.alert_level or "").upper() or None, None, Provenance.MODEL, "gdacs")
            add("area", "Affected area", g.metrics.get("affected_area_km2"), "km²", Provenance.REAL, "gdacs")
            add("countries", "Affected countries", g.metrics.get("affected_countries"), None, Provenance.REAL, "gdacs")
    return out


def aggregate_fire_clusters(obs: Sequence[Observation]) -> dict[str, Any] | None:
    """Combine every FIRMS-derived cluster linked to one incident."""
    clusters = [o for o in obs if o.source == "firms"]
    if not clusters:
        return None

    def total(key: str) -> float:
        return sum(float(v) for o in clusters if isinstance((v := o.metrics.get(key)), (int, float)))

    recent, prior = total("recent_12h"), total("prior_12h")
    if prior == 0:
        trend = "new" if recent > 0 else "inactive"
    else:
        ratio = recent / prior
        trend = "growing" if ratio > 1.3 else "declining" if ratio < 0.7 else "stable"
    return {
        "clusters": len(clusters),
        "detections": int(total("detections")),
        "frp_total_mw": round(total("frp_total_mw"), 1),
        "footprint_km2": round(total("footprint_km2"), 2),
        "trend": trend,
    }


def _merge_geometry(obs: Sequence[Observation]) -> dict[str, Any] | None:
    feats: list[dict[str, Any]] = []
    for o in obs:
        if o.geometry and o.geometry.get("type") == "FeatureCollection":
            feats.extend(o.geometry.get("features") or [])
    return {"type": "FeatureCollection", "features": feats} if feats else None


def _bbox(obs: Sequence[Observation], geometry: dict[str, Any] | None) -> tuple[float, float, float, float] | None:
    pts: list[tuple[float, float]] = [(o.lon, o.lat) for o in obs if o.has_location()]  # type: ignore[misc]
    if geometry:
        for f in geometry.get("features") or []:
            if (f.get("properties") or {}).get("role") in ("forecast_cone", "wind_60kmh"):
                continue  # forecast envelopes would inflate the incident extent
            _collect(f.get("geometry"), pts)
    return bbox_of(pts)


def _collect(geom: dict[str, Any] | None, pts: list[tuple[float, float]]) -> None:
    if not geom:
        return
    coords = geom.get("coordinates")

    def walk(c: Any) -> None:
        if isinstance(c, (list, tuple)) and c and isinstance(c[0], (int, float)):
            pts.append((float(c[0]), float(c[1])))
        elif isinstance(c, (list, tuple)):
            for x in c:
                walk(x)

    walk(coords)


def _merge_track(obs: Sequence[Observation]) -> list[dict[str, Any]]:
    """Combine track points; at equal timestamps the more authoritative source wins."""
    rank = {"nhc": 0, "gdacs": 1, "eonet": 2}
    by_time: dict[str, dict[str, Any]] = {}
    for o in sorted(obs, key=lambda x: rank.get(x.source, 9), reverse=True):
        for t in o.track:
            key = t.time.strftime("%Y-%m-%dT%H")
            by_time[key] = t.model_dump(mode="json")
    return [by_time[k] for k in sorted(by_time)]


def label_for(hazard: Hazard) -> str:
    return HAZARD_LABEL.get(hazard, hazard.value)


__all__ = ["FusionContext", "fuse", "headline_metrics", "label_for", "utcnow"]
