"""Sea level after an undersea earthquake (OBSERVED, raw): the nearest IOC tide gauges and NOAA
DART deep-ocean buoys, from an hour before the event to twelve hours after (or now).

These are raw real-time records: tides are not removed and nothing is quality-controlled, so a
tsunami shows as a short, sharp departure from the smooth tidal curve. ATLAS does not detect or
forecast tsunamis; warning centres do.
"""

from __future__ import annotations

import asyncio
import math
from collections import Counter
from datetime import datetime, timedelta
from typing import Any

import orjson
from defusedxml import ElementTree

from atlas.http.client import FetchError, HttpClient
from atlas.util.timeutil import iso_z, utcnow

IOC = "https://www.ioc-sealevelmonitoring.org/service.php"
NDBC_STATIONS = "https://www.ndbc.noaa.gov/activestations.xml"
DART = "https://www.ndbc.noaa.gov/data/realtime2/{id}.dart"
IOC_MAX_KM = 2000
DART_MAX_KM = 4000
MAX_POINTS = 240


def _km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2
    return 2 * 6371.0088 * math.asin(min(1.0, math.sqrt(a)))


def thin(points: list[tuple[datetime, float]], n: int = MAX_POINTS) -> list[dict[str, Any]]:
    if len(points) > n:
        step = len(points) / n
        points = [points[int(i * step)] for i in range(n)]
    return [{"t": iso_z(t), "v": round(v, 3)} for t, v in points]


async def ioc_stations(http: HttpClient) -> list[dict[str, Any]]:
    res = await http.get(
        IOC, params={"query": "stationlist", "showall": "a"}, ttl=timedelta(days=1), source_id="ioc-sealevel", max_bytes=16 << 20
    )
    out = []
    for s in orjson.loads(res.content) or []:
        try:
            out.append({"code": str(s["Code"])[:16], "name": str(s.get("Location") or s["Code"])[:80], "lat": float(s["Lat"]), "lon": float(s["Lon"]),
                        "country": s.get("country")})  # fmt: skip
        except (KeyError, TypeError, ValueError):
            continue
    return out


def parse_ioc(rows: list[dict[str, Any]]) -> list[tuple[datetime, float]]:
    """Keep the sensor with the most samples (stations often carry radar, pressure and float)."""
    sensors = Counter(r.get("sensor") for r in rows)
    if not sensors:
        return []
    main = sensors.most_common(1)[0][0]
    pts = []
    for r in rows:
        if r.get("sensor") != main or not isinstance(r.get("slevel"), (int, float)):
            continue
        try:
            pts.append((datetime.strptime(str(r["stime"]), "%Y-%m-%d %H:%M:%S"), float(r["slevel"])))
        except (KeyError, ValueError):
            continue
    return pts


async def ioc_series(http: HttpClient, code: str, start: datetime, end: datetime) -> list[tuple[datetime, float]]:
    params: dict[str, str | int | float] = {
        "query": "data",
        "code": code,
        "timestart": f"{start:%Y-%m-%d %H:%M}",
        "timestop": f"{end:%Y-%m-%d %H:%M}",
        "format": "json",
    }
    res = await http.get(IOC, params=params, ttl=timedelta(minutes=2), source_id="ioc-sealevel", max_bytes=8 << 20)
    return parse_ioc(orjson.loads(res.content) or [])


async def dart_stations(http: HttpClient) -> list[dict[str, Any]]:
    res = await http.get(NDBC_STATIONS, ttl=timedelta(days=1), source_id="ndbc-dart", max_bytes=8 << 20)
    out = []
    for st in ElementTree.fromstring(res.content).iter("station"):
        if st.get("type") != "dart" or st.get("dart") != "y":
            continue
        try:
            out.append(
                {
                    "code": str(st.get("id"))[:12],
                    "name": (st.get("name") or "").strip()[:80],
                    "lat": float(st.get("lat", "")),
                    "lon": float(st.get("lon", "")),
                }
            )
        except ValueError:
            continue
    return out


def parse_dart(text: str) -> list[tuple[datetime, float]]:
    pts = []
    for line in text.splitlines():
        if line.startswith("#"):
            continue
        parts = line.split()
        if len(parts) < 8:
            continue
        try:
            y, mo, d, h, mi, sec = (int(p) for p in parts[:6])
            t = datetime(y, mo, d, h, mi, sec)
            pts.append((t, float(parts[7])))
        except ValueError:
            continue
    return sorted(pts)


async def dart_series(http: HttpClient, code: str, start: datetime, end: datetime) -> list[tuple[datetime, float]]:
    res = await http.get(DART.format(id=code), ttl=timedelta(minutes=5), source_id="ndbc-dart", max_bytes=4 << 20)
    return [(t, v) for t, v in parse_dart(res.content.decode("ascii", "replace")) if start <= t <= end]


async def near_event(http: HttpClient, t: datetime, lat: float, lon: float) -> dict[str, Any]:
    start = t - timedelta(hours=1)
    end = min(utcnow(), t + timedelta(hours=12))
    out: dict[str, Any] = {"status": "ok", "provenance": "real", "event_time": iso_z(t), "gauges": [], "buoys": [], "errors": {}}

    async def pick(kind: str, stations: Any, series: Any, max_km: float, n: int) -> list[dict[str, Any]]:
        near = sorted(
            ({**s, "distance_km": round(_km(lat, lon, s["lat"], s["lon"]))} for s in stations), key=lambda s: s["distance_km"]
        )
        near = [s for s in near if s["distance_km"] <= max_km][: n * 2]
        got = await asyncio.gather(*(series(http, s["code"], start, end) for s in near), return_exceptions=True)
        result = []
        for s, pts in zip(near, got, strict=True):
            if isinstance(pts, BaseException) or not pts:
                continue
            result.append({**s, "series": thin(pts), "unit": "m"})
            if len(result) >= n:
                break
        return result

    try:
        out["gauges"] = await pick("ioc", await ioc_stations(http), ioc_series, IOC_MAX_KM, 4)
    except (FetchError, orjson.JSONDecodeError) as exc:
        out["errors"]["ioc"] = str(exc)[:200]
    try:
        out["buoys"] = await pick("dart", await dart_stations(http), dart_series, DART_MAX_KM, 3)
    except (FetchError, ElementTree.ParseError) as exc:
        out["errors"]["dart"] = str(exc)[:200]
    out["note"] = (
        "Raw real-time sea level: tides are included and nothing is quality-controlled. A tsunami shows as a short, sharp "
        "departure from the smooth tide. ATLAS does not detect or forecast tsunamis; follow your tsunami warning centre."
    )
    out["attribution"] = "Sea level: IOC Sea Level Station Monitoring Facility and station operators · NOAA NDBC DART"
    return out
