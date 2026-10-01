"""USGS earthquake connector (real-time GeoJSON summary feeds + FDSN event service)."""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any

import orjson

from atlas.connectors.base import Capability, DataConnector, FetchOutcome, Job
from atlas.http.security import safe_external_link
from atlas.models import ExternalRef, Hazard, Observation
from atlas.util.text import clean_text
from atlas.util.timeutil import from_epoch_ms

FEED = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/{name}.geojson"
FDSN = "https://earthquake.usgs.gov/fdsnws/event/1/query"

# Incident thresholds (documented in docs/METHODOLOGY.md). Every earthquake is kept as an
# observation for the seismicity layer; only these become incidents in the live stream.
INCIDENT_MIN_MAG = 4.5
INCIDENT_MIN_SIG = 600


def is_incident_candidate(mag: float | None, alert: str | None, tsunami: int | None, sig: int | None) -> bool:
    return (
        (mag is not None and mag >= INCIDENT_MIN_MAG)
        or alert in ("yellow", "orange", "red")
        or bool(tsunami)
        or (sig is not None and sig >= INCIDENT_MIN_SIG)
    )


class UsgsConnector(DataConnector):
    id = "usgs"
    name = "USGS Earthquake Hazards Program"
    capabilities = frozenset({Capability.LATEST, Capability.HISTORICAL})

    def jobs(self) -> list[Job]:
        return [
            Job("usgs.hour", timedelta(minutes=1), lambda: self.fetch_feed("all_hour", ttl=timedelta(seconds=55))),
            Job("usgs.day", timedelta(minutes=10), lambda: self.fetch_feed("all_day", ttl=timedelta(minutes=9))),
            Job("usgs.week", timedelta(hours=1), lambda: self.fetch_feed("2.5_week", ttl=timedelta(minutes=55))),
            Job("usgs.significant", timedelta(hours=1), lambda: self.fetch_feed("significant_month", ttl=timedelta(minutes=55))),
        ]

    async def fetch_feed(self, name: str, ttl: timedelta) -> FetchOutcome:
        res = await self.ctx.http.get(FEED.format(name=name), ttl=ttl, source_id=self.id)
        outcome = self.parse(res.content)
        outcome.absorb(res)
        return outcome

    async def fetch_historical(self, start: datetime, end: datetime, **filters: object) -> FetchOutcome:
        params: dict[str, str | int | float] = {
            "format": "geojson",
            "starttime": start.isoformat(timespec="seconds"),
            "endtime": end.isoformat(timespec="seconds"),
            "orderby": "time",
            "limit": int(filters.get("limit", 20000)),  # type: ignore[call-overload]
            "minmagnitude": float(filters.get("min_magnitude", 2.5)),  # type: ignore[arg-type]
        }
        bbox = filters.get("bbox")
        if isinstance(bbox, (list, tuple)) and len(bbox) == 4:
            w, s, e, n = (float(v) for v in bbox)
            params.update(minlongitude=w, minlatitude=s, maxlongitude=e, maxlatitude=n)
        res = await self.ctx.http.get(FDSN, params=params, ttl=timedelta(hours=6), source_id=self.id)
        outcome = self.parse(res.content)
        outcome.absorb(res)
        return outcome

    def parse(self, content: bytes) -> FetchOutcome:
        out = FetchOutcome()
        try:
            data = orjson.loads(content)
        except orjson.JSONDecodeError:
            out.notes.append("malformed JSON from USGS")
            out.rejected += 1
            return out
        features = data.get("features") if isinstance(data, dict) else None
        if not isinstance(features, list):
            out.notes.append("unexpected USGS payload shape")
            return out
        for feature in features:
            out.received += 1
            obs = self.normalize(feature)
            if obs is None:
                out.filtered += 1
                continue
            self.accept(out, obs)
        return out

    def normalize(self, feature: dict[str, Any]) -> Observation | None:
        props = feature.get("properties") or {}
        geom = feature.get("geometry") or {}
        coords = geom.get("coordinates") or []
        event_type = (props.get("type") or "earthquake").lower()
        if event_type != "earthquake":
            return None  # quarry blasts, explosions, ice quakes: out of scope
        if len(coords) < 2 or props.get("time") is None or not feature.get("id"):
            return None
        mag = _num(props.get("mag"))
        alert = props.get("alert")
        tsunami = props.get("tsunami")
        sig = props.get("sig")
        ids = [i for i in (props.get("ids") or "").split(",") if i]
        refs = {ExternalRef(scheme="usgs", id=str(feature["id"]))}
        refs.update(ExternalRef(scheme="usgs", id=i) for i in ids)
        place = clean_text(props.get("place"), 200)
        mag_type = props.get("magType")
        title = f"M{mag:.1f} earthquake — {place}" if mag is not None else f"Earthquake — {place}"
        event_time = from_epoch_ms(props.get("time"))
        assert event_time is not None
        return Observation(
            source=self.id,
            external_id=str(feature["id"]),
            hazard=Hazard.EARTHQUAKE,
            title=title,
            lat=_num(coords[1]),
            lon=_num(coords[0]),
            depth_km=_num(coords[2]) if len(coords) > 2 else None,
            event_time=event_time,
            source_updated_at=from_epoch_ms(props.get("updated")),
            magnitude=mag,
            magnitude_unit=mag_type,
            alert_level=alert,
            status=props.get("status"),
            url=safe_external_link(props.get("url")),
            metrics={
                "place": place,
                "sig": sig,
                "felt": props.get("felt"),
                "cdi": _num(props.get("cdi")),
                "mmi": _num(props.get("mmi")),
                "tsunami": bool(tsunami),
                "net": props.get("net"),
                "nst": props.get("nst"),
                "gap": _num(props.get("gap")),
                "rms": _num(props.get("rms")),
                "has_shakemap": "shakemap" in (props.get("types") or ""),
                "has_pager": "losspager" in (props.get("types") or ""),
                "has_finite_fault": "finite-fault" in (props.get("types") or ""),
                "detail_url": safe_external_link(props.get("detail")),
            },
            external_refs=sorted(refs, key=lambda r: r.id),
            incident_candidate=is_incident_candidate(mag, alert, tsunami, sig),
        )


def _num(v: object) -> float | None:
    if v is None or isinstance(v, bool):
        return None
    try:
        f = float(v)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    return f if f == f else None
