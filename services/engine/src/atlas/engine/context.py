"""On-demand environmental context for an incident location (Open-Meteo).

Coordinates are rounded to 0.05° (~5 km) before querying, which both protects privacy for
user-chosen points and lets nearby requests share a cache entry. All values are numerical
weather model output and are labelled MODEL.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any

import orjson

from atlas.http.client import HttpClient

FORECAST = "https://api.open-meteo.com/v1/forecast"

CURRENT = [
    "temperature_2m", "relative_humidity_2m", "apparent_temperature", "precipitation", "weather_code",
    "cloud_cover", "pressure_msl", "wind_speed_10m", "wind_direction_10m", "wind_gusts_10m",
]  # fmt: skip
HOURLY = [
    "temperature_2m",
    "precipitation",
    "precipitation_probability",
    "wind_speed_10m",
    "wind_gusts_10m",
    "relative_humidity_2m",
]

WMO_CODES = {
    0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast", 45: "Fog", 48: "Depositing rime fog",
    51: "Light drizzle", 53: "Drizzle", 55: "Dense drizzle", 56: "Freezing drizzle", 57: "Dense freezing drizzle",
    61: "Light rain", 63: "Rain", 65: "Heavy rain", 66: "Freezing rain", 67: "Heavy freezing rain",
    71: "Light snow", 73: "Snow", 75: "Heavy snow", 77: "Snow grains", 80: "Rain showers", 81: "Heavy rain showers",
    82: "Violent rain showers", 85: "Snow showers", 86: "Heavy snow showers", 95: "Thunderstorm",
    96: "Thunderstorm with hail", 99: "Thunderstorm with heavy hail",
}  # fmt: skip


def _round(v: float) -> float:
    return round(round(v / 0.05) * 0.05, 2)


async def weather(http: HttpClient, lat: float, lon: float) -> dict[str, Any]:
    params: dict[str, str | int | float] = {
        "latitude": _round(lat),
        "longitude": _round(lon),
        "current": ",".join(CURRENT),
        "hourly": ",".join(HOURLY),
        "past_days": 1,
        "forecast_days": 2,
        "timezone": "GMT",
        "wind_speed_unit": "kmh",
    }
    res = await http.get(FORECAST, params=params, ttl=timedelta(minutes=30), source_id="open-meteo")
    data = orjson.loads(res.content)
    cur = data.get("current") or {}
    code = cur.get("weather_code")
    return {
        "provenance": "model",
        "source": "open-meteo",
        "attribution": "Weather data by Open-Meteo.com (CC BY 4.0)",
        "model_note": "Numerical weather model output (best-match model for this location), not station observations.",
        "grid": {"lat": data.get("latitude"), "lon": data.get("longitude"), "elevation_m": data.get("elevation")},
        "fetched_at": res.fetched_at.isoformat() + "Z",
        "stale": res.stale,
        "current": {**cur, "weather_text": WMO_CODES.get(code) if isinstance(code, int) else None},
        "current_units": data.get("current_units") or {},
        "hourly": data.get("hourly") or {},
        "hourly_units": data.get("hourly_units") or {},
    }
