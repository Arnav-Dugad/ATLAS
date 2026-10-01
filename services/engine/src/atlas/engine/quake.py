"""Earthquake intelligence, all from the USGS (no key):

* Official products quoted as issued: ShakeMap intensity contours, PAGER residents per
  intensity and alert level, the USGS aftershock forecast (OAF), and the origin's location
  uncertainty. ATLAS never computes or alters a forecast; it shows the one USGS published.
* Catalogue context: the largest earthquakes near the epicentre since 1900, and this week's
  count against the ten-year weekly rate for the area (Poisson tail probability). That is a
  description of the present, not a prediction.

Product files are fetched only from URLs inside the USGS event document, and only from
https://earthquake.usgs.gov; anything else is ignored.
"""

from __future__ import annotations

import asyncio
import math
import re
from datetime import datetime, timedelta
from typing import Any
from urllib.parse import urlsplit

import orjson

from atlas.http.client import FetchError, HttpClient
from atlas.util.timeutil import from_epoch_ms, iso_z, utcnow

FDSN = "https://earthquake.usgs.gov/fdsnws/event/1/query"
FDSN_COUNT = "https://earthquake.usgs.gov/fdsnws/event/1/count"
HOST = "earthquake.usgs.gov"
EVENT_ID = re.compile(r"^[a-z0-9]{2,24}$")
SOURCE = "usgs"

ANALOG_RADIUS_KM = 300
ANALOG_MIN_MAG = 5.5
ACTIVITY_RADIUS_KM = 200
ACTIVITY_MIN_MAG = 4.0  # roughly where the global catalogue is complete since the 2010s
BASELINE_YEARS = 10


def valid_event_id(event_id: str) -> bool:
    return bool(EVENT_ID.match(event_id))


def _usgs_url(url: Any) -> str | None:
    if not isinstance(url, str):
        return None
    parts = urlsplit(url)
    return url if parts.scheme == "https" and parts.hostname == HOST else None


def _ms(v: Any) -> str | None:
    try:
        return iso_z(from_epoch_ms(int(v)))
    except (TypeError, ValueError, OverflowError):
        return None


def _float(v: Any) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


async def _json(http: HttpClient, url: str, ttl: timedelta, params: dict[str, Any] | None = None) -> Any:
    res = await http.get(url, params=params, ttl=ttl, source_id=SOURCE, max_bytes=16 * 1024 * 1024)
    return orjson.loads(res.content)


def _first(products: dict[str, Any], kind: str) -> dict[str, Any] | None:
    items = products.get(kind) or []
    # The preferred product is listed first; prefer one from the event's own network if present.
    return items[0] if items and isinstance(items[0], dict) else None


def _content(product: dict[str, Any], *names: str) -> str | None:
    contents = product.get("contents") or {}
    for name in names:
        url = _usgs_url((contents.get(name) or {}).get("url"))
        if url:
            return url
    return None


def _round_coords(geom: Any) -> Any:
    if isinstance(geom, list):
        if geom and isinstance(geom[0], (int, float)):
            return [round(float(geom[0]), 4), round(float(geom[1]), 4)]
        return [_round_coords(g) for g in geom]
    return geom


async def _shakemap(http: HttpClient, p: dict[str, Any]) -> dict[str, Any]:
    props = p.get("properties") or {}
    out: dict[str, Any] = {
        "version": props.get("version"),
        "status": props.get("map-status") or props.get("review-status"),
        "max_mmi": _float(props.get("maxmmi")),
        "updated_at": _ms(p.get("updateTime")),
        "contours": None,
        "max_contour_mmi": None,
    }
    url = _content(p, "download/cont_mmi.json")
    if url:
        data = await _json(http, url, timedelta(minutes=30))
        feats = []
        for f in (data.get("features") or [])[:40]:
            g = f.get("geometry") or {}
            pr = f.get("properties") or {}
            if g.get("type") not in ("LineString", "MultiLineString"):
                continue
            feats.append(
                {
                    "type": "Feature",
                    "properties": {
                        "mmi": _float(pr.get("value")),
                        "color": pr.get("color") if isinstance(pr.get("color"), str) else None,
                    },
                    "geometry": {"type": g["type"], "coordinates": _round_coords(g.get("coordinates"))},
                }
            )
        out["contours"] = {"type": "FeatureCollection", "features": feats}
        levels = [f["properties"]["mmi"] for f in feats if f["properties"]["mmi"] is not None]
        out["max_contour_mmi"] = max(levels) if levels else None
    return out


async def _pager(http: HttpClient, p: dict[str, Any]) -> dict[str, Any]:
    props = p.get("properties") or {}
    out: dict[str, Any] = {
        "alert_level": props.get("alertlevel"),
        "status": props.get("review-status"),
        "updated_at": _ms(p.get("updateTime")),
        "exposure": None,
    }
    url = _content(p, "json/exposures.json", "exposures.json")
    if url:
        data = await _json(http, url, timedelta(minutes=30))
        pop = data.get("population_exposure") or {}
        mmi = pop.get("mmi") or []
        counts = pop.get("aggregated_exposure") or []
        out["exposure"] = [
            {"mmi": int(m), "population": int(c)} for m, c in zip(mmi, counts, strict=False) if isinstance(c, (int, float))
        ]
    return out


async def _aftershocks(http: HttpClient, p: dict[str, Any]) -> dict[str, Any] | None:
    url = _content(p, "forecast.json")
    if not url:
        return None
    data = await _json(http, url, timedelta(minutes=30))
    windows = []
    for w in data.get("forecast") or []:
        bins = [
            {
                "magnitude": _float(b.get("magnitude")),
                "probability": _float(b.get("probability")),
                "median": b.get("median"),
                "p95_min": b.get("p95minimum"),
                "p95_max": b.get("p95maximum"),
            }
            for b in w.get("bins") or []
        ]
        windows.append({"label": w.get("label"), "start": _ms(w.get("timeStart")), "end": _ms(w.get("timeEnd")), "bins": bins})
    model = data.get("model") or {}
    return {
        "issued_at": _ms(data.get("creationTime")),
        "expires_at": _ms(data.get("expireTime")),
        "next_forecast_at": _ms(data.get("nextForecastTime")),
        "advisory_window": data.get("advisoryTimeFrame"),
        "model": model.get("name"),
        "observed": [{"magnitude": _float(o.get("magnitude")), "count": o.get("count")} for o in data.get("observations") or []],
        "windows": windows,
    }


def _location(p: dict[str, Any]) -> dict[str, Any]:
    props = p.get("properties") or {}
    return {
        "horizontal_error_km": _float(props.get("horizontal-error")),
        "depth_error_km": _float(props.get("vertical-error") or props.get("depth-error")),
        "magnitude_error": _float(props.get("magnitude-error")),
        "azimuthal_gap_deg": _float(props.get("azimuthal-gap")),
        "stations": int(props["num-stations-used"]) if str(props.get("num-stations-used", "")).isdigit() else None,
        "status": props.get("review-status"),
    }


async def products(http: HttpClient, event_id: str) -> dict[str, Any]:
    """Official USGS products for one event, as issued."""
    detail = await _json(http, FDSN, timedelta(minutes=5), {"eventid": event_id, "format": "geojson"})
    props = detail.get("properties") or {}
    prods = props.get("products") or {}
    out: dict[str, Any] = {
        "status": "ok",
        "event_id": event_id,
        "event_url": _usgs_url(props.get("url")),
        "provenance": "real",
        "attribution": "U.S. Geological Survey (public domain)",
        "shakemap": None,
        "pager": None,
        "aftershocks": None,
        "location": None,
        "errors": [],
    }
    tasks: dict[str, Any] = {}
    if (p := _first(prods, "shakemap")) is not None:
        tasks["shakemap"] = _shakemap(http, p)
    if (p := _first(prods, "losspager")) is not None:
        tasks["pager"] = _pager(http, p)
    if (p := _first(prods, "oaf")) is not None:
        tasks["aftershocks"] = _aftershocks(http, p)
    if (p := _first(prods, "origin")) is not None:
        out["location"] = _location(p)
    results = await asyncio.gather(*tasks.values(), return_exceptions=True)
    for key, res in zip(tasks, results, strict=True):
        if isinstance(res, BaseException):
            if not isinstance(res, (FetchError, orjson.JSONDecodeError, KeyError, TypeError, ValueError)):
                raise res
            out["errors"].append(f"{key}: {res}")
        else:
            out[key] = res
    return out


# ----------------------------------------------------------------------- catalogue context
def poisson_tail(k: int, lam: float) -> float:
    """P(X ≥ k) for X ~ Poisson(lam), accurate in the far tail."""
    if k <= 0:
        return 1.0
    if lam <= 0:
        return 0.0
    if k > lam:
        term = math.exp(-lam + k * math.log(lam) - math.lgamma(k + 1))
        total = 0.0
        i = k
        while term > 1e-18 * max(total, 1e-300) and i < k + 10_000:
            total += term
            i += 1
            term *= lam / i
        return min(1.0, total)
    term = math.exp(-lam)
    cdf = 0.0
    for i in range(k):
        cdf += term
        term *= lam / (i + 1)
    return max(0.0, 1.0 - cdf)


async def _count(http: HttpClient, lat: float, lon: float, start: datetime, end: datetime) -> int:
    params = {
        "format": "geojson",
        "latitude": f"{lat:.4f}",
        "longitude": f"{lon:.4f}",
        "maxradiuskm": ACTIVITY_RADIUS_KM,
        "minmagnitude": ACTIVITY_MIN_MAG,
        "starttime": start.strftime("%Y-%m-%dT%H:%M:%S"),
        "endtime": end.strftime("%Y-%m-%dT%H:%M:%S"),
    }
    data = await _json(http, FDSN_COUNT, timedelta(hours=1), params)
    return int(data["count"])


async def activity(http: HttpClient, lat: float, lon: float, now: datetime | None = None) -> dict[str, Any]:
    """This week's M4+ count within 200 km against the ten-year weekly mean before it."""
    now = (now or utcnow()).replace(minute=0, second=0, microsecond=0)
    week_start = now - timedelta(days=7)
    base_start = week_start - timedelta(days=365.25 * BASELINE_YEARS)
    week, base = await asyncio.gather(_count(http, lat, lon, week_start, now), _count(http, lat, lon, base_start, week_start))
    weeks = (week_start - base_start).days / 7
    rate = base / weeks
    tail = poisson_tail(week, rate)
    ratio = week / rate if rate > 0 else None
    if week == 0:
        verdict = "quiet"
    elif tail < 0.001:
        verdict = "far above usual"
    elif tail < 0.05:
        verdict = "above usual"
    else:
        verdict = "within the usual range"
    return {
        "status": "ok",
        "provenance": "derived",
        "radius_km": ACTIVITY_RADIUS_KM,
        "min_magnitude": ACTIVITY_MIN_MAG,
        "week_count": week,
        "baseline_count": base,
        "baseline_years": BASELINE_YEARS,
        "weekly_rate": round(rate, 3),
        "ratio": round(ratio, 1) if ratio is not None else None,
        "p_value": tail,
        "verdict": verdict,
        "method": (
            f"USGS ComCat count of M{ACTIVITY_MIN_MAG:g}+ within {ACTIVITY_RADIUS_KM} km in the last 7 days, compared with "
            f"the mean weekly count over the {BASELINE_YEARS} years before. p is the chance of at least this many in a "
            "week if events arrived at the usual rate (Poisson). Aftershocks count too, so a large earthquake makes its "
            "own week unusual. This describes the present; it is not a forecast."
        ),
        "computed_at": iso_z(utcnow()),
    }


async def analogs(http: HttpClient, lat: float, lon: float, exclude: set[str]) -> dict[str, Any]:
    """The largest earthquakes within 300 km since 1900 (USGS ComCat, which includes ISC-GEM)."""
    params = {
        "format": "geojson",
        "latitude": f"{lat:.4f}",
        "longitude": f"{lon:.4f}",
        "maxradiuskm": ANALOG_RADIUS_KM,
        "starttime": "1900-01-01",
        "minmagnitude": ANALOG_MIN_MAG,
        "orderby": "magnitude",
        "limit": 12,
    }
    data = await _json(http, FDSN, timedelta(hours=24), params)
    items = []
    for f in data.get("features") or []:
        ids = set(str((f.get("properties") or {}).get("ids") or "").strip(",").split(",")) | {str(f.get("id"))}
        if ids & exclude:
            continue
        p = f.get("properties") or {}
        coords = (f.get("geometry") or {}).get("coordinates") or [None, None, None]
        items.append(
            {
                "id": f.get("id"),
                "magnitude": _float(p.get("mag")),
                "place": p.get("place"),
                "time": _ms(p.get("time")),
                "lat": _float(coords[1]),
                "lon": _float(coords[0]),
                "depth_km": _float(coords[2]) if len(coords) > 2 else None,
                "url": _usgs_url(p.get("url")),
            }
        )
        if len(items) >= 6:
            break
    return {
        "status": "ok",
        "provenance": "real",
        "radius_km": ANALOG_RADIUS_KM,
        "min_magnitude": ANALOG_MIN_MAG,
        "items": items,
        "note": "USGS ComCat since 1900 (pre-1970s events from the ISC-GEM catalogue; early magnitudes and locations are less certain).",
    }
