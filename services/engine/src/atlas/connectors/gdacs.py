"""GDACS connector: multi-hazard alert list plus per-episode geometry enrichment."""

from __future__ import annotations

import asyncio
import re
from datetime import datetime, timedelta
from typing import Any

import orjson
from shapely.geometry import mapping, shape

from atlas.connectors.base import Capability, DataConnector, FetchOutcome, Job
from atlas.http.client import FetchError
from atlas.http.security import safe_external_link
from atlas.models import ExternalRef, Hazard, Observation, TrackPoint
from atlas.util.text import clean_text
from atlas.util.timeutil import parse_iso, utcnow

LIST_URL = "https://www.gdacs.org/gdacsapi/api/events/geteventlist/EVENTS4APP"
GEOMETRY_URL = "https://www.gdacs.org/gdacsapi/api/polygons/getgeometry"

HAZARD_MAP: dict[str, Hazard] = {
    "EQ": Hazard.EARTHQUAKE,
    "TC": Hazard.TROPICAL_CYCLONE,
    "FL": Hazard.FLOOD,
    "VO": Hazard.VOLCANO,
    "DR": Hazard.DROUGHT,
    "WF": Hazard.WILDFIRE,
    "TS": Hazard.TSUNAMI,
}

_KEY_RE = re.compile(r"^(\d{2})(\d{2})(\d{2})(\d{2})$")  # MMDDhhmm
KMH_PER_KT = 1.852


class GdacsConnector(DataConnector):
    id = "gdacs"
    name = "GDACS"
    capabilities = frozenset({Capability.LATEST, Capability.GEOMETRY})

    def jobs(self) -> list[Job]:
        return [Job("gdacs.events", timedelta(minutes=10), self.fetch_latest)]

    async def fetch_latest(self) -> FetchOutcome:
        res = await self.ctx.http.get(LIST_URL, ttl=timedelta(minutes=9), source_id=self.id)
        out = self.parse_list(res.content)
        out.absorb(res)
        out.complete_snapshot = True
        await self._enrich(out)
        return out

    def parse_list(self, content: bytes) -> FetchOutcome:
        out = FetchOutcome()
        try:
            data = orjson.loads(content)
        except orjson.JSONDecodeError:
            out.notes.append("malformed JSON from GDACS")
            out.rejected += 1
            return out
        for feature in (data or {}).get("features") or []:
            out.received += 1
            obs = self.normalize(feature)
            if obs is None:
                out.filtered += 1
                continue
            self.accept(out, obs)
        return out

    def normalize(self, feature: dict[str, Any]) -> Observation | None:
        p = feature.get("properties") or {}
        hazard = HAZARD_MAP.get(p.get("eventtype", ""))
        if hazard is None or p.get("eventid") is None:
            return None
        coords = (feature.get("geometry") or {}).get("coordinates") or []
        start = parse_iso(p.get("fromdate"))
        if start is None or len(coords) < 2:
            return None
        sev = p.get("severitydata") or {}
        severity_value = sev.get("severity")
        severity_unit = (sev.get("severityunit") or "").strip()
        metrics: dict[str, float | int | str | bool | None] = {
            "alert_score": p.get("alertscore"),
            "episode_id": p.get("episodeid"),
            "episode_alert": (p.get("episodealertlevel") or "").lower() or None,
            "severity_text": clean_text(sev.get("severitytext"), 300),
            "upstream_source": p.get("source"),
            "affected_countries": ", ".join(
                c.get("countryname", "") for c in p.get("affectedcountries") or [] if c.get("countryname")
            )
            or None,
            "geometry_url": safe_external_link((p.get("url") or {}).get("geometry")),
        }
        magnitude: float | None = None
        unit: str | None = None
        if hazard is Hazard.EARTHQUAKE and severity_unit == "M":
            magnitude, unit = _f(severity_value), "M"
            depth = re.search(r"Depth:\s*([\d.]+)\s*km", sev.get("severitytext") or "")
            metrics["depth_km"] = float(depth.group(1)) if depth else None
        elif hazard is Hazard.TROPICAL_CYCLONE and severity_unit == "km/h":
            kmh = _f(severity_value)
            metrics["max_wind_kmh"] = round(kmh, 1) if kmh is not None else None
            metrics["max_wind_kt"] = round(kmh / KMH_PER_KT, 1) if kmh is not None else None
        elif hazard is Hazard.WILDFIRE and severity_unit == "ha":
            metrics["burned_area_ha"] = _f(severity_value)
        elif hazard is Hazard.DROUGHT and severity_unit == "km2":
            metrics["affected_area_km2"] = _f(severity_value)

        refs = {ExternalRef(scheme="gdacs", id=f"{p['eventtype']}:{p['eventid']}")}
        if p.get("glide"):
            refs.add(ExternalRef(scheme="glide", id=str(p["glide"])))
        if p.get("sourceid") and hazard is Hazard.EARTHQUAKE:
            refs.add(ExternalRef(scheme="usgs", id=str(p["sourceid"])))
        names = [n for n in (p.get("eventname"),) if n]
        alert = (p.get("alertlevel") or "").lower() or None
        is_current = str(p.get("iscurrent", "")).lower() == "true"
        return Observation(
            source=self.id,
            external_id=f"{p['eventtype']}:{p['eventid']}",
            hazard=hazard,
            title=clean_text(p.get("name") or p.get("description"), 200) or f"GDACS {p['eventtype']} event",
            lat=_f(coords[1]),
            lon=_f(coords[0]),
            event_time=start,
            end_time=parse_iso(p.get("todate")),
            source_updated_at=parse_iso(p.get("datemodified")),
            magnitude=magnitude,
            magnitude_unit=unit,
            alert_level=alert,
            status="current" if is_current else "past",
            url=safe_external_link((p.get("url") or {}).get("report")),
            country_iso3=(p.get("iso3") or None),
            metrics=metrics,
            external_refs=sorted(refs, key=lambda r: (r.scheme, r.id)),
            names=names,
            incident_candidate=is_current or alert in ("orange", "red"),
            depth_km=metrics.get("depth_km") if hazard is Hazard.EARTHQUAKE else None,  # type: ignore[arg-type]
        )

    async def _enrich(self, out: FetchOutcome) -> None:
        """Fetch geometry for events where it adds analytical value. Episode-keyed URLs
        cache for 24 h, so unchanged episodes never trigger another request."""
        targets = [o for o in out.observations if self._wants_geometry(o)]
        sem = asyncio.Semaphore(2)

        async def one(obs: Observation) -> None:
            url = obs.metrics.get("geometry_url")
            if not isinstance(url, str):
                return
            async with sem:
                try:
                    res = await self.ctx.http.get(url, ttl=timedelta(hours=24), source_id=self.id)
                except FetchError as exc:
                    out.notes.append(f"geometry unavailable for {obs.external_id}: {exc}")
                    return
            try:
                self.apply_geometry(obs, orjson.loads(res.content))
            except (orjson.JSONDecodeError, ValueError, TypeError, KeyError) as exc:
                out.notes.append(f"malformed geometry for {obs.external_id}: {exc}")

        await asyncio.gather(*(one(o) for o in targets))

    @staticmethod
    def _wants_geometry(obs: Observation) -> bool:
        if obs.status != "current" and obs.alert_level not in ("orange", "red"):
            return False
        if obs.hazard in (Hazard.TROPICAL_CYCLONE, Hazard.FLOOD, Hazard.EARTHQUAKE):
            return True
        if obs.hazard is Hazard.WILDFIRE:
            area = obs.metrics.get("burned_area_ha")
            return obs.alert_level in ("orange", "red") or (isinstance(area, (int, float)) and area >= 10_000)
        return obs.alert_level in ("orange", "red")

    def apply_geometry(self, obs: Observation, data: dict[str, Any]) -> None:
        features = data.get("features") or []
        keep: list[dict[str, Any]] = []
        track_points: list[tuple[datetime, float, float, str]] = []
        segments: list[tuple[tuple[float, float], str, bool]] = []
        ref_time = parse_iso(features[0]["properties"].get("polygondate")) if features else None
        for f in features:
            props = f.get("properties") or {}
            cls = str(props.get("Class") or "")
            geom = f.get("geometry")
            if not geom:
                continue
            if obs.hazard is Hazard.EARTHQUAKE and props.get("sourceid"):
                ref = ExternalRef(scheme="usgs", id=str(props["sourceid"]))
                if ref not in obs.external_refs:
                    obs.external_refs.append(ref)
            if cls.startswith("Point_Polygon_Point"):
                when = _key_time(str(props.get("key") or ""), obs.event_time)
                if when is not None:
                    c = shape(geom).centroid
                    track_points.append((when, c.y, c.x, str(props.get("polygonlabel") or "")))
            elif cls.startswith("Line_Line") and geom.get("type") == "LineString":
                first = geom["coordinates"][0]
                segments.append(((first[0], first[1]), str(props.get("polygonlabel") or ""), bool(props.get("forecast"))))
            elif cls in ("Poly_Cones", "Poly_Green", "Poly_Orange", "Poly_Red", "Poly_area", "Poly_Affected", "Poly_Circle"):
                if cls in ("Poly_Green", "Poly_Orange", "Poly_Red") and _is_timestamp_label(props.get("polygonlabel")):
                    continue  # per-forecast-step buffers duplicate the envelope buffers
                simplified = shape(geom).simplify(0.02, preserve_topology=True)
                keep.append(
                    {
                        "type": "Feature",
                        "geometry": mapping(simplified),
                        "properties": {"role": _role(cls), "label": props.get("polygonlabel"), "source": "gdacs"},
                    }
                )
        if keep:
            obs.geometry = {"type": "FeatureCollection", "features": keep}
        if track_points:
            now = ref_time or utcnow()
            pts: list[TrackPoint] = []
            for when, lat, lon, _label in sorted(track_points):
                category = _nearest_segment_label(lat, lon, segments)
                pts.append(
                    TrackPoint(
                        time=when,
                        lat=round(lat, 3),
                        lon=round(lon, 3),
                        category=category,
                        kind="forecast" if when > now else "observed",
                        source="gdacs",
                    )  # fmt: skip
                )
            obs.track = pts


def _role(cls: str) -> str:
    return {
        "Poly_Cones": "forecast_cone",
        "Poly_Green": "wind_60kmh",
        "Poly_Orange": "wind_90kmh",
        "Poly_Red": "wind_120kmh",
        "Poly_area": "affected_area",
        "Poly_Affected": "affected_area",
        "Poly_Circle": "radius_100km",
    }.get(cls, "area")


def _is_timestamp_label(label: object) -> bool:
    return isinstance(label, str) and bool(re.match(r"^\d{2}/\d{2} \d{2}:\d{2}", label))


def _key_time(key: str, anchor: datetime) -> datetime | None:
    """GDACS track keys are MMDDhhmm without a year; resolve against the event start,
    handling storms that cross New Year."""
    m = _KEY_RE.match(key)
    if not m:
        return None
    month, day, hour, minute = (int(g) for g in m.groups())
    for year in (anchor.year, anchor.year + 1):
        try:
            candidate = datetime(year, month, day, hour, minute)
        except ValueError:
            return None
        if candidate >= anchor - timedelta(days=2):
            return candidate
    return None


def _nearest_segment_label(lat: float, lon: float, segments: list[tuple[tuple[float, float], str, bool]]) -> str | None:
    best: tuple[float, str] | None = None
    for (slon, slat), label, _ in segments:
        d = (slon - lon) ** 2 + (slat - lat) ** 2
        if d < 0.04 and (best is None or d < best[0]):
            best = (d, label)
    return best[1] if best else None


def _f(v: object) -> float | None:
    try:
        return float(v)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
