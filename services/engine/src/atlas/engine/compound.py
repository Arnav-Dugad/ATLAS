"""Compound conditions around an incident: heat, fire weather, air quality and other hazards
nearby, shown together because they compound one another (heat dries fuel, fire fouls the air,
a cyclone floods a burn scar). Every part is labelled with its own provenance.

* Heat (MODEL vs climatology): Open-Meteo's forecast daily maximum against the 90th percentile of
  ERA5 daily maxima for the same ±7 calendar days in 2010–2024. Three or more consecutive days
  above it is called a heatwave, a common percentile-based definition (e.g. Perkins & Alexander
  2013). The climatology is fetched as 15 small requests and cached for 30 days, keeping well
  inside Open-Meteo's free fair-use limits.
* Fire weather (MODEL): relative humidity ≤ 25 % with wind ≥ 30 km/h at once in the next 48 h,
  a generic hot-dry-windy screen; agencies set their own thresholds.
* Air quality (OBSERVED): the nearest PM2.5 readings, when an OpenAQ key is configured.
* Other hazards (DERIVED): active ATLAS incidents of another type within 300 km.
"""

from __future__ import annotations

import asyncio
import math
from datetime import date, timedelta
from typing import Any

import numpy as np
import orjson

from atlas.http.client import FetchError, HttpClient
from atlas.store.db import Database
from atlas.util.timeutil import utcnow

FORECAST = "https://api.open-meteo.com/v1/forecast"
ARCHIVE = "https://archive-api.open-meteo.com/v1/archive"
BASE_YEARS = range(2010, 2025)
WINDOW_DAYS = 7
HEAT_MIN_C = 25.0  # a "hot for the season" winter day is not heat stress
NEARBY_KM = 300
RH_MAX, WIND_MIN = 25.0, 30.0


def _r(v: float) -> float:
    return round(v * 4) / 4  # 0.25° keeps the cache shared between nearby incidents


async def climatology_p90(http: HttpClient, lat: float, lon: float, day: date) -> tuple[float, int] | None:
    """90th percentile of daily maxima for day±7 over the base years, and the sample size."""

    async def one(year: int) -> list[float]:
        try:
            centre = day.replace(year=year)
        except ValueError:  # 29 February
            centre = date(year, 2, 28)
        params: dict[str, str | int | float] = {
            "latitude": _r(lat),
            "longitude": _r(lon),
            "start_date": (centre - timedelta(days=WINDOW_DAYS)).isoformat(),
            "end_date": (centre + timedelta(days=WINDOW_DAYS)).isoformat(),
            "daily": "temperature_2m_max",
            "timezone": "GMT",
        }
        res = await http.get(ARCHIVE, params=params, ttl=timedelta(days=30), source_id="open-meteo")
        vals = (orjson.loads(res.content).get("daily") or {}).get("temperature_2m_max") or []
        return [float(v) for v in vals if isinstance(v, (int, float))]

    parts = await asyncio.gather(*(one(y) for y in BASE_YEARS), return_exceptions=True)
    values = [v for p in parts if isinstance(p, list) for v in p]
    if len(values) < 60:
        return None
    return float(np.percentile(values, 90)), len(values)


def heat_days(maxima: list[float | None], p90: float) -> tuple[list[bool], int]:
    """Which days exceed both the local 90th percentile and HEAT_MIN_C, and the longest run."""
    hot = [m is not None and m > p90 and m >= HEAT_MIN_C for m in maxima]
    run = best = 0
    for h in hot:
        run = run + 1 if h else 0
        best = max(best, run)
    return hot, best


def fire_weather(hourly: dict[str, list[Any]]) -> dict[str, Any] | None:
    """Hours in the forecast with RH ≤ 25 % and wind ≥ 30 km/h at the same time."""
    times = hourly.get("time") or []
    rh = hourly.get("relative_humidity_2m") or []
    wind = hourly.get("wind_speed_10m") or []
    hits = [
        t
        for t, h, w in zip(times, rh, wind, strict=False)
        if isinstance(h, (int, float)) and isinstance(w, (int, float)) and h <= RH_MAX and w >= WIND_MIN
    ]
    if not times:
        return None
    return {"hours": len(hits), "first": hits[0] if hits else None, "min_rh": min((h for h in rh if isinstance(h, (int, float))), default=None),
            "max_wind_kmh": max((w for w in wind if isinstance(w, (int, float))), default=None)}  # fmt: skip


def nearby_hazards(db: Database, incident_id: str, hazard: str, lat: float, lon: float) -> list[dict[str, Any]]:
    since = utcnow() - timedelta(days=7)
    with db.read() as cur:
        rows = cur.execute(
            "SELECT id, hazard, title, lat, lon, severity_level FROM incidents WHERE status = 'active' AND id <> ? "
            "AND hazard <> ? AND lat IS NOT NULL AND last_observation_at >= ? AND abs(lat - ?) < 3 AND abs(lon - ?) < ?",
            [incident_id, hazard, since, lat, lon, min(180.0, 3.0 / max(0.1, math.cos(math.radians(lat))))],
        ).fetchall()
    out = []
    p1 = math.radians(lat)
    for iid, hz, title, la, lo, sev in rows:
        p2 = math.radians(la)
        a = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lo - lon) / 2) ** 2
        km = 2 * 6371.0088 * math.asin(min(1.0, math.sqrt(a)))
        if km <= NEARBY_KM:
            out.append({"id": iid, "hazard": hz, "title": title, "distance_km": round(km), "severity": sev})
    return sorted(out, key=lambda x: x["distance_km"])[:8]


async def conditions(http: HttpClient, db: Database, incident_id: str, hazard: str, lat: float, lon: float,
                     air: dict[str, Any] | None) -> dict[str, Any]:  # fmt: skip
    today = utcnow().date()
    params: dict[str, str | int | float] = {
        "latitude": _r(lat),
        "longitude": _r(lon),
        "daily": "temperature_2m_max",
        "hourly": "relative_humidity_2m,wind_speed_10m",
        "past_days": 2,
        "forecast_days": 4,
        "timezone": "GMT",
        "wind_speed_unit": "kmh",
    }
    out: dict[str, Any] = {
        "status": "ok",
        "parts": {},
        "attribution": "Weather and ERA5 climate data by Open-Meteo.com (CC BY 4.0)",
    }
    try:
        fc, clim = await asyncio.gather(
            http.get(FORECAST, params=params, ttl=timedelta(minutes=30), source_id="open-meteo"),
            climatology_p90(http, lat, lon, today),
        )
        data = orjson.loads(fc.content)
        daily = data.get("daily") or {}
        days = daily.get("time") or []
        maxima = [float(v) if isinstance(v, (int, float)) else None for v in daily.get("temperature_2m_max") or []]
        if clim is not None:
            p90, n = clim
            hot, run = heat_days(maxima, p90)
            out["parts"]["heat"] = {
                "active": run >= 1,
                "heatwave": run >= 3,
                "provenance": "model",
                "p90_c": round(p90, 1),
                "sample_days": n,
                "days": [{"date": d, "max_c": m, "hot": h} for d, m, h in zip(days, maxima, hot, strict=False)],
                "longest_run": run,
                "method": f"Forecast daily maximum above the {BASE_YEARS.start}–{BASE_YEARS.stop - 1} 90th percentile for "
                f"±{WINDOW_DAYS} days of the year (ERA5) and at least {HEAT_MIN_C:g} °C; 3+ days in a row = heatwave.",
            }
        hourly = data.get("hourly") or {}
        # only the next 48 h of the hourly series
        now_key = utcnow().strftime("%Y-%m-%dT%H:00")
        idx = [i for i, t in enumerate(hourly.get("time") or []) if t >= now_key][:48]
        fw = fire_weather({k: [v[i] for i in idx] for k, v in hourly.items() if isinstance(v, list)})
        if fw is not None:
            out["parts"]["fire_weather"] = {
                "active": fw["hours"] > 0,
                "provenance": "model",
                **fw,
                "method": f"Hours in the next 48 h with relative humidity ≤ {RH_MAX:g} % and wind ≥ {WIND_MIN:g} km/h together; "
                "a generic screen, not an official fire-danger rating.",
            }
    except (FetchError, orjson.JSONDecodeError) as exc:
        out["parts"]["weather_error"] = f"Open-Meteo did not answer ({exc})."
    if air is not None:
        pm = [
            {**r, "station": st.get("name"), "distance_km": st.get("distance_km")}
            for st in air.get("stations") or []
            for r in st.get("readings") or []
            if r.get("parameter") == "pm25" and isinstance(r.get("value"), (int, float))
        ]
        if air.get("status") == "ok" and pm:
            worst = max(pm, key=lambda r: r["value"])
            out["parts"]["air"] = {
                "active": worst["value"] > 35.4,  # US EPA 24-h AQI "unhealthy for sensitive groups" breakpoint
                "provenance": "real",
                "pm25": worst["value"],
                "station": worst.get("station"),
                "distance_km": worst.get("distance_km"),
                "observed_at": worst.get("at"),
                "method": "Highest PM2.5 at stations within 25 km (OpenAQ); above 35.4 µg/m³ is 'unhealthy for sensitive groups' "
                "on the US EPA scale (a 24-hour standard; these are hourly readings).",
            }
        else:
            out["parts"]["air_note"] = air.get("reason") or "No PM2.5 station reported nearby."
    near = await asyncio.to_thread(nearby_hazards, db, incident_id, hazard, lat, lon)
    out["parts"]["nearby"] = {"active": bool(near), "provenance": "derived", "items": near,
                              "method": f"Active ATLAS incidents of another hazard type within {NEARBY_KM} km, updated in the last 7 days."}  # fmt: skip
    active = [k for k, v in out["parts"].items() if isinstance(v, dict) and v.get("active")]
    out["active"] = active
    out["compound"] = len(active) >= 2
    return out
