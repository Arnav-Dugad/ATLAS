"""EMSC-CSEM earthquakes (FDSN event web service, GeoJSON) — an independent second agency.

EMSC's real-time catalogue corroborates USGS: the same earthquake reported by both raises an
incident's source count and confidence, and EMSC sometimes reports Euro-Mediterranean events
first. Licence: CC BY 4.0 (seismicportal.eu).
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any

import orjson

from atlas.connectors.base import DataConnector, FetchOutcome, Job
from atlas.models import ExternalRef, Hazard, Observation
from atlas.util.text import clean_text
from atlas.util.timeutil import parse_iso, utcnow

FDSN = "https://www.seismicportal.eu/fdsnws/event/1/query"
EVENT_PAGE = "https://www.seismicportal.eu/eventdetails.html?unid={unid}"
MIN_MAG = 4.0
INCIDENT_MIN_MAG = 4.5  # same threshold as the USGS connector


def _num(v: object) -> float | None:
    if v is None or isinstance(v, bool):
        return None
    try:
        f = float(v)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    return f if f == f else None


def region_title(region: str) -> str:
    """'MORO GULF, MINDANAO, PHILIPPINES' → 'Moro Gulf, Mindanao, Philippines'."""
    small = {"of", "the", "and", "near", "off", "in"}
    words = region.lower().split(" ")
    return " ".join(w if (i and w in small) else w[:1].upper() + w[1:] for i, w in enumerate(words))


class EmscConnector(DataConnector):
    id = "emsc"
    name = "EMSC-CSEM earthquakes"

    def jobs(self) -> list[Job]:
        return [Job("emsc.day", timedelta(minutes=5), self.fetch_latest)]

    async def fetch_latest(self) -> FetchOutcome:
        params: dict[str, str | int | float] = {
            "format": "json",
            "starttime": (utcnow() - timedelta(hours=24)).isoformat(timespec="seconds"),
            "minmag": MIN_MAG,
            "orderby": "time",
            "limit": 1000,
        }
        res = await self.ctx.http.get(FDSN, params=params, ttl=timedelta(minutes=4), source_id=self.id, max_bytes=8 * 1024 * 1024)
        out = self.parse(res.content)
        out.absorb(res)
        return out

    def parse(self, content: bytes) -> FetchOutcome:
        out = FetchOutcome()
        try:
            data = orjson.loads(content)
        except orjson.JSONDecodeError:
            out.notes.append("malformed JSON from EMSC")
            out.rejected += 1
            return out
        features = data.get("features") if isinstance(data, dict) else None
        if not isinstance(features, list):
            out.notes.append("unexpected EMSC payload shape")
            return out
        for feature in features:
            out.received += 1
            obs = self.normalize(feature) if isinstance(feature, dict) else None
            if obs is None:
                out.filtered += 1
                continue
            self.accept(out, obs)
        return out

    def normalize(self, feature: dict[str, Any]) -> Observation | None:
        p = feature.get("properties") or {}
        unid = str(p.get("unid") or feature.get("id") or "")
        if not unid or (p.get("evtype") or "ke") not in ("ke", "se"):  # known / suspected earthquake only
            return None
        lat, lon = _num(p.get("lat")), _num(p.get("lon"))
        event_time = parse_iso(p.get("time"))
        if lat is None or lon is None or event_time is None:
            return None
        mag = _num(p.get("mag"))
        region = region_title(clean_text(p.get("flynn_region"), 160))
        title = f"M{mag:.1f} earthquake — {region}" if mag is not None else f"Earthquake — {region}"
        return Observation(
            source=self.id,
            external_id=unid,
            hazard=Hazard.EARTHQUAKE,
            title=title,
            lat=lat,
            lon=lon,
            depth_km=_num(p.get("depth")),
            event_time=event_time,
            source_updated_at=parse_iso(p.get("lastupdate")),
            magnitude=mag,
            magnitude_unit=clean_text(p.get("magtype"), 10) or None,
            status="automatic" if p.get("source_catalog") == "EMSC-RTS" else None,
            url=EVENT_PAGE.format(unid=unid),
            metrics={
                "region": region,
                "author": clean_text(p.get("auth"), 30),
                "catalog": clean_text(p.get("source_catalog"), 30),
            },
            external_refs=[ExternalRef(scheme="emsc", id=unid)],
            incident_candidate=mag is not None and mag >= INCIDENT_MIN_MAG,
        )
