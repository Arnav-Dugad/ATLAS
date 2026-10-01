"""NOAA National Hurricane Center active storms connector."""

from __future__ import annotations

from datetime import timedelta
from typing import Any

import orjson

from atlas.connectors.base import DataConnector, FetchOutcome, Job
from atlas.http.security import safe_external_link
from atlas.models import ExternalRef, Hazard, Observation, TrackPoint
from atlas.util.geo import parse_hemisphere_coord
from atlas.util.text import clean_text
from atlas.util.timeutil import parse_iso

URL = "https://www.nhc.noaa.gov/CurrentStorms.json"

CLASSIFICATION = {
    "TD": "Tropical Depression",
    "TS": "Tropical Storm",
    "HU": "Hurricane",
    "STD": "Subtropical Depression",
    "STS": "Subtropical Storm",
    "PTC": "Post-tropical Cyclone",
    "PC": "Potential Tropical Cyclone",
    "TY": "Typhoon",
}


def saffir_simpson(wind_kt: float | None) -> str | None:
    """Saffir–Simpson Hurricane Wind Scale category from 1-minute sustained wind (kt)."""
    if wind_kt is None:
        return None
    if wind_kt >= 137:
        return "Category 5"
    if wind_kt >= 113:
        return "Category 4"
    if wind_kt >= 96:
        return "Category 3"
    if wind_kt >= 83:
        return "Category 2"
    if wind_kt >= 64:
        return "Category 1"
    if wind_kt >= 34:
        return "Tropical storm"
    return "Tropical depression"


class NhcConnector(DataConnector):
    id = "nhc"
    name = "NOAA National Hurricane Center"

    def jobs(self) -> list[Job]:
        return [Job("nhc.current", timedelta(minutes=15), self.fetch_latest)]

    async def fetch_latest(self) -> FetchOutcome:
        res = await self.ctx.http.get(URL, ttl=timedelta(minutes=10), source_id=self.id)
        out = self.parse(res.content)
        out.absorb(res)
        out.complete_snapshot = True
        return out

    def parse(self, content: bytes) -> FetchOutcome:
        out = FetchOutcome()
        try:
            data = orjson.loads(content)
        except orjson.JSONDecodeError:
            out.notes.append("malformed JSON from NHC")
            out.rejected += 1
            return out
        for storm in (data or {}).get("activeStorms") or []:
            out.received += 1
            obs = self.normalize(storm)
            if obs is None:
                out.filtered += 1
                continue
            self.accept(out, obs)
        return out

    def normalize(self, s: dict[str, Any]) -> Observation | None:
        sid = s.get("id")
        updated = parse_iso(s.get("lastUpdate"))
        if not sid or updated is None:
            return None
        lat = s.get("latitudeNumeric")
        lon = s.get("longitudeNumeric")
        if lat is None and s.get("latitude"):
            lat = parse_hemisphere_coord(s["latitude"])
        if lon is None and s.get("longitude"):
            lon = parse_hemisphere_coord(s["longitude"])
        wind = _f(s.get("intensity"))
        pressure = _f(s.get("pressure"))
        cls = str(s.get("classification") or "")
        label = CLASSIFICATION.get(cls, "Tropical Cyclone")
        name = clean_text(s.get("name"), 60)
        adv = s.get("publicAdvisory") or {}
        track = s.get("forecastTrack") or {}
        cone = s.get("trackCone") or {}
        category = saffir_simpson(wind)
        hazard = Hazard.TROPICAL_CYCLONE
        return Observation(
            source=self.id,
            external_id=str(sid),
            hazard=hazard,
            title=f"{label} {name}",
            lat=float(lat) if lat is not None else None,
            lon=float(lon) if lon is not None else None,
            event_time=updated,
            source_updated_at=updated,
            magnitude=None,
            status="active",
            url=safe_external_link(adv.get("url")) or "https://www.nhc.noaa.gov/",
            metrics={
                "classification": cls,
                "max_wind_kt": wind,
                "max_wind_kmh": round(wind * 1.852, 1) if wind is not None else None,
                "min_pressure_mb": pressure,
                "saffir_simpson": category if cls == "HU" else None,
                "movement_dir_deg": _f(s.get("movementDir")),
                "movement_speed_mph": _f(s.get("movementSpeed")),
                "advisory_number": adv.get("advNum"),
                "forecast_track_kmz": safe_external_link(track.get("kmzFile")),
                "forecast_cone_kmz": safe_external_link(cone.get("kmzFile")),
                "basin_bin": s.get("binNumber"),
            },
            track=[
                TrackPoint(
                    time=updated, lat=float(lat), lon=float(lon), wind_kt=wind, pressure_mb=pressure, category=cls, source="nhc"
                )
            ]
            if lat is not None and lon is not None
            else [],  # fmt: skip
            external_refs=[ExternalRef(scheme="nhc", id=str(sid))],
            names=[name],
            incident_candidate=True,
        )


def _f(v: object) -> float | None:
    try:
        return float(v)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
