"""Regional and national agencies for an earthquake (REAL), matched to the event by time and
distance and shown beside USGS/EMSC rather than merged into them:

* JMA (Japan): magnitude Mj, depth and the maximum seismic intensity (shindo) observed.
* NCS (India): magnitude and location from India's National Center for Seismology. Read from
  the JSON embedded in its public event page (no documented API), so a page change can break
  it; the card then says so instead of guessing.
* INCOIS (India): the Indian Tsunami Early Warning Centre's bulletin and its own evaluation of
  the threat to India, quoted.
"""

from __future__ import annotations

import html
import math
import re
from datetime import datetime, timedelta
from typing import Any
from urllib.parse import urlsplit

import orjson

from atlas.http.client import FetchError, HttpClient
from atlas.util.timeutil import iso_z, parse_iso

JMA_LIST = "https://www.jma.go.jp/bosai/quake/data/list.json"
NCS_PAGE = "https://riseq.seismo.gov.in/riseq/earthquake"
INCOIS_LIST = "https://tsunami.incois.gov.in/itews/DSSProducts/OPR/past90days.json"
IST = timedelta(hours=5, minutes=30)
JST = timedelta(hours=9)
SHINDO = {"1": "1", "2": "2", "3": "3", "4": "4", "5-": "5 lower", "5+": "5 upper", "6-": "6 lower", "6+": "6 upper", "7": "7"}


def _km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2
    return 2 * 6371.0088 * math.asin(min(1.0, math.sqrt(a)))


def _float(v: Any) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def parse_jma_cod(cod: str) -> tuple[float, float, float | None] | None:
    """ISO 6709-style '+35.8+140.7-40000/' → (lat, lon, depth km)."""
    m = re.match(r"^([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)([+-]\d+)?/?$", cod or "")
    if not m:
        return None
    depth = abs(int(m.group(3))) / 1000 if m.group(3) else None
    return float(m.group(1)), float(m.group(2)), depth


def match(
    candidates: list[dict[str, Any]], t: datetime, lat: float, lon: float, max_s: float, max_km: float
) -> dict[str, Any] | None:
    best = None
    for c in candidates:
        if c.get("time") is None or c.get("lat") is None:
            continue
        dt = abs((c["time"] - t).total_seconds())
        km = _km(lat, lon, c["lat"], c["lon"])
        if dt <= max_s and km <= max_km and (best is None or (dt, km) < (best[0], best[1])):
            best = (dt, km, c)
    if best is None:
        return None
    return {**best[2], "time": iso_z(best[2]["time"]), "delta_s": round(best[0]), "distance_km": round(best[1], 1)}


# ------------------------------------------------------------------------------------- JMA
def parse_jma(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by_event: dict[str, dict[str, Any]] = {}
    for it in items:
        eid = str(it.get("eid") or "")
        at = parse_iso(it.get("at"))
        pos = parse_jma_cod(str(it.get("cod") or ""))
        if not eid or at is None:
            continue
        ev = by_event.setdefault(eid, {"id": eid, "time": at, "lat": None, "lon": None})
        if pos:
            ev["lat"], ev["lon"], ev["depth_km"] = pos
        if _float(it.get("mag")) is not None:
            ev["magnitude"] = _float(it.get("mag"))
        maxi = str(it.get("maxi") or "")
        if maxi in SHINDO:
            ev["max_intensity"] = SHINDO[maxi]
        if it.get("en_anm"):
            ev["area"] = str(it["en_anm"])[:120]
    return list(by_event.values())


async def jma(http: HttpClient, t: datetime, lat: float, lon: float) -> dict[str, Any] | None:
    res = await http.get(JMA_LIST, ttl=timedelta(minutes=1), source_id="jma", max_bytes=8 << 20)
    hit = match(parse_jma(orjson.loads(res.content)), t, lat, lon, max_s=120, max_km=150)
    if hit:
        hit["url"] = "https://www.jma.go.jp/bosai/map.html#contents=earthquake_map"
        hit["note"] = "JMA magnitude (Mj) and seismic intensity on the JMA scale (0–7)."
    return hit


# ------------------------------------------------------------------------------------- NCS
_NCS_JSON = re.compile(r"data-json='(\{[^']{0,2000}\})'")


def parse_ncs(page: str) -> list[dict[str, Any]]:
    out = []
    for raw in _NCS_JSON.findall(page):
        try:
            d = orjson.loads(html.unescape(raw))
        except orjson.JSONDecodeError:
            continue
        try:
            local = datetime.strptime(str(d.get("origin_time", "")).replace(" IST", ""), "%Y-%m-%d %H:%M:%S")
            la, lo = (float(v) for v in str(d.get("lat_long", "")).split(","))
        except ValueError:
            continue
        m = re.search(r"M:\s*([\d.]+)\s*,\s*D:\s*([\d.]+)\s*km", str(d.get("magnitude_depth", "")))
        out.append(
            {
                "id": str(d.get("event_id", ""))[:80],
                "time": local - IST,
                "lat": la,
                "lon": lo,
                "magnitude": float(m.group(1)) if m else None,
                "depth_km": float(m.group(2)) if m else None,
                "region": str(d.get("event_name", ""))[:120],
                "status": str(d.get("event_type", ""))[:40],
            }
        )
    return out


async def ncs(http: HttpClient, t: datetime, lat: float, lon: float) -> dict[str, Any] | None:
    res = await http.get(NCS_PAGE, ttl=timedelta(minutes=5), source_id="ncs-india", max_bytes=8 << 20)
    events = parse_ncs(res.content.decode("utf-8", "replace"))
    if not events:
        raise ValueError("no events found on the NCS page (its layout may have changed)")
    hit = match(events, t, lat, lon, max_s=180, max_km=150)
    if hit:
        hit["url"] = NCS_PAGE
    return hit


# ---------------------------------------------------------------------------------- INCOIS
async def incois(http: HttpClient, t: datetime, lat: float, lon: float) -> dict[str, Any] | None:
    res = await http.get(INCOIS_LIST, ttl=timedelta(minutes=5), source_id="incois", max_bytes=4 << 20)
    events = []
    for d in orjson.loads(res.content).get("datasets") or []:
        try:
            local = datetime.strptime(str(d.get("ORIGINTIME")), "%Y-%m-%d %H:%M:%S")
        except ValueError:
            continue
        detail = d.get("detail")
        events.append(
            {
                "id": str(d.get("EVID", ""))[:40],
                "time": local - IST,
                "lat": _float(d.get("LATITUDE")),
                "lon": _float(d.get("LONGITUDE")),
                "magnitude": _float(d.get("MAGNITUDE")),
                "depth_km": _float(d.get("DEPTH")),
                "region": str(d.get("REGIONNAME", ""))[:120],
                "bulletin": d.get("BULNO"),
                "detail": detail if isinstance(detail, str) and urlsplit(detail).hostname == "tsunami.incois.gov.in" else None,
            }
        )
    hit = match(events, t, lat, lon, max_s=300, max_km=300)
    if hit and hit.get("detail"):
        try:
            b = await http.get(hit["detail"], ttl=timedelta(hours=1), source_id="incois", max_bytes=1 << 20)
            info = (orjson.loads(b.content) or [{}])[0].get("event_info", [{}])[0]
            hit["evaluation"] = str(info.get("evaluation", ""))[:600] or None
            hit["bulletin_title"] = str(info.get("bulletinTitle", "")).strip(". ")[:120] or None
        except (FetchError, orjson.JSONDecodeError, IndexError, AttributeError, TypeError):
            pass
    if hit:
        hit["url"] = "https://tsunami.incois.gov.in/TEWS/"
    return hit


async def for_quake(http: HttpClient, t: datetime, lat: float, lon: float, magnitude: float | None) -> dict[str, Any]:
    """Only agencies whose region covers the event are asked."""
    import asyncio

    tasks: dict[str, Any] = {}
    if 20 <= lat <= 50 and 120 <= lon <= 155:
        tasks["jma"] = jma(http, t, lat, lon)
    if -5 <= lat <= 45 and 55 <= lon <= 105:
        tasks["ncs"] = ncs(http, t, lat, lon)
    if (magnitude or 0) >= 6.0:
        tasks["incois"] = incois(http, t, lat, lon)
    results = await asyncio.gather(*tasks.values(), return_exceptions=True)
    out: dict[str, Any] = {"status": "ok", "provenance": "real", "asked": list(tasks), "errors": {}}
    for key, res in zip(tasks, results, strict=True):
        if isinstance(res, (FetchError, ValueError, orjson.JSONDecodeError)):
            out["errors"][key] = str(res)[:200]
            out[key] = None
        elif isinstance(res, BaseException):
            raise res
        else:
            out[key] = res
    return out
