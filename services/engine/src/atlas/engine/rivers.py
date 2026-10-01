"""Rivers near an incident:

* GloFAS modelled discharge (MODEL) via the Open-Meteo Flood API. GloFAS cells are 5 km, and the
  cell nearest a point is often a minor channel, so ATLAS first probes a 3×3 neighbourhood
  (one request) and keeps the cell carrying the most water, then reads two years of daily
  history for it to rank today's flow. The 14-day forecast is GloFAS's ensemble, shown as issued.
* USGS stream gauges (OBSERVED, United States only): the latest gauge height and discharge at
  stations within ~40 km, from the USGS Water Data OGC API.
"""

from __future__ import annotations

import math
from datetime import date, timedelta
from typing import Any

import numpy as np
import orjson

from atlas.http.client import FetchError, HttpClient

FLOOD = "https://flood-api.open-meteo.com/v1/flood"
USGS_LATEST = "https://api.waterdata.usgs.gov/ogcapi/v0/collections/latest-continuous/items"
USGS_SITES = "https://api.waterdata.usgs.gov/ogcapi/v0/collections/monitoring-locations/items"
STEP = 0.05  # degrees between probed cells (GloFAS v4 grid is 0.05°)


async def glofas(http: HttpClient, lat: float, lon: float, today: date) -> dict[str, Any] | None:
    lats = [round(lat + dy * STEP, 3) for dy in (-1, 0, 1) for _dx in (-1, 0, 1)]
    lons = [round(lon + dx * STEP, 3) for _dy in (-1, 0, 1) for dx in (-1, 0, 1)]
    probe = await http.get(
        FLOOD,
        params={
            "latitude": ",".join(map(str, lats)),
            "longitude": ",".join(map(str, lons)),
            "daily": "river_discharge",
            "past_days": 30,
            "forecast_days": 1,
        },
        ttl=timedelta(hours=6),
        source_id="glofas",
    )
    data = orjson.loads(probe.content)
    cells = data if isinstance(data, list) else [data]
    best = None
    for c in cells:
        recent = [v for v in (c.get("daily") or {}).get("river_discharge") or [] if isinstance(v, (int, float))]
        if recent and (best is None or np.mean(recent) > best[0]):
            best = (float(np.mean(recent)), float(c["latitude"]), float(c["longitude"]))
    if best is None or best[0] <= 0:
        return None
    _, clat, clon = best
    hist = await http.get(
        FLOOD,
        params={
            "latitude": clat,
            "longitude": clon,
            "daily": "river_discharge,river_discharge_median,river_discharge_min,river_discharge_max",
            "start_date": (today - timedelta(days=730)).isoformat(),
            "end_date": (today + timedelta(days=14)).isoformat(),
        },
        ttl=timedelta(hours=6),
        source_id="glofas",
    )
    d = orjson.loads(hist.content).get("daily") or {}
    times = d.get("time") or []
    q: list[float | None] = [float(v) if isinstance(v, (int, float)) else None for v in d.get("river_discharge") or []]
    idx = next((i for i, t in enumerate(times) if t == today.isoformat()), None)
    if idx is None or q[idx] is None:
        return None
    past = [v for v in q[: idx + 1] if v is not None]
    now_q = float(q[idx] or 0.0)
    pct = float((np.array(past) < now_q).mean() * 100) if past else None
    fc = []
    for i in range(idx, len(times)):
        med = (d.get("river_discharge_median") or [None] * len(times))[i]
        lo = (d.get("river_discharge_min") or [None] * len(times))[i]
        hi = (d.get("river_discharge_max") or [None] * len(times))[i]
        fc.append({"date": times[i], "median": med, "min": lo, "max": hi})
    peak = max((f for f in fc if isinstance(f["median"], (int, float))), key=lambda f: f["median"], default=None)
    return {
        "provenance": "model",
        "cell": {"lat": clat, "lon": clon, "distance_km": round(_km(lat, lon, clat, clon), 1)},
        "today": {"date": times[idx], "discharge": now_q},
        "percentile_2y": round(pct, 0) if pct is not None else None,
        "max_2y": max(past) if past else None,
        "history": [
            {"date": t, "discharge": v}
            for t, v in zip(times[max(0, idx - 90) : idx + 1], q[max(0, idx - 90) : idx + 1], strict=True)
        ],
        "forecast": fc[1:],
        "forecast_peak": peak,
        "unit": "m³/s",
        "method": "GloFAS v4 modelled daily discharge for the 5 km cell with the most water within ±0.05° of the incident; "
        "today's value ranked against the past two years at that cell. The forecast is GloFAS's 50-member ensemble (median and range).",
    }


def _km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2
    return 2 * 6371.0088 * math.asin(min(1.0, math.sqrt(a)))


async def usgs_gauges(http: HttpClient, lat: float, lon: float, today: date) -> list[dict[str, Any]]:
    bbox = f"{lon - 0.4:.3f},{lat - 0.4:.3f},{lon + 0.4:.3f},{lat + 0.4:.3f}"
    since = f"{(today - timedelta(days=3)).isoformat()}T00:00:00Z/.."  # retired gauges keep their last value forever
    latest = await http.get(USGS_LATEST, params={"f": "json", "bbox": bbox, "parameter_code": "00065,00060", "datetime": since, "limit": 200},
                            ttl=timedelta(minutes=15), source_id="usgs-water")  # fmt: skip
    stations: dict[str, dict[str, Any]] = {}
    for f in orjson.loads(latest.content).get("features") or []:
        p = f.get("properties") or {}
        coords = (f.get("geometry") or {}).get("coordinates") or [None, None]
        sid = p.get("monitoring_location_id")
        if not isinstance(sid, str) or coords[1] is None:
            continue
        try:
            value = float(p["value"])
        except (KeyError, TypeError, ValueError):
            continue
        st = stations.setdefault(sid, {"id": sid, "name": sid, "lat": coords[1], "lon": coords[0],
                                       "distance_km": round(_km(lat, lon, coords[1], coords[0]), 1)})  # fmt: skip
        key = "stage" if p.get("parameter_code") == "00065" else "discharge"
        st[key] = {"value": value, "unit": p.get("unit_of_measure"), "time": p.get("time"), "approval": p.get("approval_status")}
    nearest = sorted(stations.values(), key=lambda s: s["distance_km"])[:8]
    if nearest:
        sites = await http.get(USGS_SITES, params={"f": "json", "id": ",".join(s["id"] for s in nearest), "limit": 20},
                               ttl=timedelta(days=7), source_id="usgs-water")  # fmt: skip
        names = {
            f.get("id"): (f.get("properties") or {}).get("monitoring_location_name")
            for f in orjson.loads(sites.content).get("features") or []
        }
        for s in nearest:
            s["name"] = names.get(s["id"]) or s["id"]
    return nearest


async def rivers(http: HttpClient, lat: float, lon: float, today: date, in_us: bool) -> dict[str, Any]:
    out: dict[str, Any] = {"status": "ok", "errors": {}}
    try:
        out["glofas"] = await glofas(http, lat, lon, today)
    except (FetchError, orjson.JSONDecodeError, KeyError, TypeError, ValueError) as exc:
        out["glofas"] = None
        out["errors"]["glofas"] = str(exc)[:200]
    if in_us:
        try:
            out["gauges"] = await usgs_gauges(http, lat, lon, today)
        except (FetchError, orjson.JSONDecodeError) as exc:
            out["gauges"] = []
            out["errors"]["usgs-water"] = str(exc)[:200]
    out["attribution"] = "River discharge: Copernicus GloFAS via Open-Meteo.com (CC BY 4.0)" + (
        " · Gauges: U.S. Geological Survey" if in_us else ""
    )
    return out
