"""NASA EONET v3 connector."""

from __future__ import annotations

import re
from datetime import timedelta
from typing import Any

import orjson

from atlas.connectors.base import DataConnector, FetchOutcome, Job
from atlas.http.security import safe_external_link
from atlas.models import ExternalRef, Hazard, Observation, TrackPoint
from atlas.util.text import clean_text
from atlas.util.timeutil import parse_iso

EVENTS_URL = "https://eonet.gsfc.nasa.gov/api/v3/events"

CATEGORY_MAP: dict[str, Hazard] = {
    "wildfires": Hazard.WILDFIRE,
    "severeStorms": Hazard.SEVERE_STORM,
    "volcanoes": Hazard.VOLCANO,
    "floods": Hazard.FLOOD,
    "seaLakeIce": Hazard.SEA_LAKE_ICE,
    "drought": Hazard.DROUGHT,
    "dustHaze": Hazard.DUST_HAZE,
    "landslides": Hazard.LANDSLIDE,
    "earthquakes": Hazard.EARTHQUAKE,
    "tempExtremes": Hazard.EXTREME_HEAT,
    "snow": Hazard.EXTREME_COLD,
}
_TC_RE = re.compile(r"\b(tropical|hurricane|typhoon|cyclone)\b", re.IGNORECASE)
# EONET wildfire events below this size (acres) stay as observations only; they can still
# corroborate a FIRMS-derived cluster but don't open an incident on their own.
WILDFIRE_INCIDENT_ACRES = 5000.0


class EonetConnector(DataConnector):
    id = "eonet"
    name = "NASA EONET"

    def jobs(self) -> list[Job]:
        return [Job("eonet.open", timedelta(minutes=20), self.fetch_latest)]

    async def fetch_latest(self) -> FetchOutcome:
        res = await self.ctx.http.get(
            EVENTS_URL, params={"status": "open", "days": 30}, ttl=timedelta(minutes=15), source_id=self.id
        )
        out = self.parse(res.content)
        out.absorb(res)
        out.complete_snapshot = True
        return out

    def parse(self, content: bytes) -> FetchOutcome:
        out = FetchOutcome()
        try:
            data = orjson.loads(content)
        except orjson.JSONDecodeError:
            out.notes.append("malformed JSON from EONET")
            out.rejected += 1
            return out
        for event in (data or {}).get("events") or []:
            out.received += 1
            obs = self.normalize(event)
            if obs is None:
                out.filtered += 1
                continue
            self.accept(out, obs)
        return out

    def normalize(self, event: dict[str, Any]) -> Observation | None:
        cats = [c.get("id") for c in event.get("categories") or []]
        hazard = next((CATEGORY_MAP[c] for c in cats if c in CATEGORY_MAP), None)
        title = clean_text(event.get("title"), 200)
        if hazard is None or not title or not event.get("id"):
            return None
        if hazard is Hazard.SEVERE_STORM and _TC_RE.search(title):
            hazard = Hazard.TROPICAL_CYCLONE
        geoms = [g for g in event.get("geometry") or [] if g.get("date")]
        if not geoms:
            return None
        geoms.sort(key=lambda g: g["date"])
        first, last = geoms[0], geoms[-1]
        lat, lon = _position(last)
        start = parse_iso(first["date"])
        updated = parse_iso(last["date"])
        if start is None:
            return None

        metrics: dict[str, float | int | str | bool | None] = {"observation_count": len(geoms)}
        mag_value = last.get("magnitudeValue")
        mag_unit = (last.get("magnitudeUnit") or "").strip()
        if mag_value is not None:
            if mag_unit == "kts":
                metrics["max_wind_kt"] = float(mag_value)
            elif mag_unit == "acres":
                metrics["area_acres"] = float(mag_value)
                metrics["burned_area_ha"] = round(float(mag_value) * 0.404686, 1)
            else:
                metrics["magnitude_value"] = float(mag_value)
                metrics["magnitude_unit"] = mag_unit or None

        refs = {ExternalRef(scheme="eonet", id=str(event["id"]))}
        source_links: list[str] = []
        for src in event.get("sources") or []:
            url = safe_external_link(src.get("url"))
            if url:
                source_links.append(f"{src.get('id')}: {url}")
            m = re.search(r"eventid=(\d+)", src.get("url") or "")
            if m and src.get("id") == "GDACS":
                gtype = re.search(r"eventtype=([A-Z]{2})", src.get("url") or "")
                if gtype:
                    refs.add(ExternalRef(scheme="gdacs", id=f"{gtype.group(1)}:{m.group(1)}"))
        metrics["upstream_sources"] = ", ".join(str(s.get("id")) for s in event.get("sources") or []) or None

        track: list[TrackPoint] = []
        if hazard in (Hazard.TROPICAL_CYCLONE, Hazard.SEVERE_STORM):
            for g in geoms:
                t = parse_iso(g["date"])
                glat, glon = _position(g)
                if t is None or glat is None or glon is None:
                    continue
                wind = g.get("magnitudeValue") if g.get("magnitudeUnit") == "kts" else None
                track.append(TrackPoint(time=t, lat=glat, lon=glon, wind_kt=wind, source="eonet"))

        geometry = None
        if last.get("type") == "Polygon":
            geometry = {
                "type": "FeatureCollection",
                "features": [{"type": "Feature", "geometry": {"type": "Polygon", "coordinates": last["coordinates"]},
                              "properties": {"role": "area", "source": "eonet"}}],
            }  # fmt: skip

        candidate = hazard not in (Hazard.SEA_LAKE_ICE,)
        if hazard is Hazard.WILDFIRE:
            acres = metrics.get("area_acres")
            candidate = isinstance(acres, float) and acres >= WILDFIRE_INCIDENT_ACRES

        return Observation(
            source=self.id,
            external_id=str(event["id"]),
            hazard=hazard,
            title=title,
            lat=lat,
            lon=lon,
            event_time=start,
            end_time=parse_iso(event.get("closed")),
            source_updated_at=updated,
            magnitude=None,
            status="closed" if event.get("closed") else "open",
            url=safe_external_link(event.get("link")),
            description=clean_text(event.get("description"), 1000) or None,
            metrics=metrics,
            geometry=geometry,
            track=track,
            external_refs=sorted(refs, key=lambda r: (r.scheme, r.id)),
            names=[title],
            incident_candidate=candidate,
        )


def _position(g: dict[str, Any]) -> tuple[float | None, float | None]:
    coords = g.get("coordinates")
    if g.get("type") == "Point" and isinstance(coords, list) and len(coords) >= 2:
        return float(coords[1]), float(coords[0])
    if g.get("type") == "Polygon" and coords:
        ring = coords[0]
        if ring:
            lons = [p[0] for p in ring]
            lats = [p[1] for p in ring]
            return sum(lats) / len(lats), sum(lons) / len(lons)
    return None, None
