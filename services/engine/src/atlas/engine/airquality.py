"""Air quality near an incident from OpenAQ v3 (on demand; needs a free OpenAQ API key).

Finds monitoring stations within 25 km, keeps only those that reported in the last 24 hours
(OpenAQ also lists long-dead stations), and reads the latest value of each station's PM2.5,
PM10, NO₂, O₃, SO₂ and CO sensors. Values are reported as measured (OBSERVED provenance) with
their station, provider and time; ATLAS does not average, interpolate or convert them.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any

import orjson

from atlas.http.client import FetchError, HttpClient
from atlas.util.geo import haversine_km
from atlas.util.timeutil import iso_z, parse_iso, utcnow

API = "https://api.openaq.org/v3"
RADIUS_M = 25_000
MAX_STATIONS = 5
FRESH = timedelta(hours=24)
PARAMETERS = {"pm25": "PM2.5", "pm10": "PM10", "no2": "NO₂", "o3": "O₃", "so2": "SO₂", "co": "CO"}
NOTE = (
    "Hourly readings from the nearest monitoring stations, as reported. Health guidelines refer to "
    "24-hour averages (WHO 2021: PM2.5 15 µg/m³, PM10 45 µg/m³), so a single reading is indicative only. "
    "Stations include low-cost sensor networks (e.g. AirGradient, Clarity, PurpleAir) as well as reference monitors; "
    "the provider is shown for each."
)


def unavailable(reason: str, action: str | None = None) -> dict[str, Any]:
    return {"status": "unavailable", "kind": "air_quality", "provenance": "unavailable", "reason": reason, "action": action}


async def _get(http: HttpClient, key: str, path: str, params: dict[str, str | int | float] | None = None) -> Any:
    res = await http.get(f"{API}{path}", params=params, headers={"X-API-Key": key, "Accept": "application/json"},
                         ttl=timedelta(minutes=15), source_id="openaq", max_bytes=4 * 1024 * 1024, timeout_s=25)  # fmt: skip
    return orjson.loads(res.content)


def fresh_stations(locations: list[dict[str, Any]], lat: float, lon: float, now: Any) -> list[dict[str, Any]]:
    """Stations that reported within the last 24 h and measure at least one tracked pollutant."""
    out = []
    for loc in locations:
        last = parse_iso((loc.get("datetimeLast") or {}).get("utc"))
        coords = loc.get("coordinates") or {}
        la, lo = coords.get("latitude"), coords.get("longitude")
        if last is None or la is None or lo is None or now - last > FRESH:
            continue
        sensors = {
            s["id"]: (s["parameter"]["name"], s["parameter"].get("units"))
            for s in loc.get("sensors") or []
            if isinstance(s, dict) and (s.get("parameter") or {}).get("name") in PARAMETERS
        }
        if not sensors:
            continue
        out.append(
            {
                "id": loc.get("id"),
                "name": str(loc.get("name") or "Station")[:120],
                "provider": str((loc.get("provider") or {}).get("name") or "")[:80] or None,
                "lat": float(la),
                "lon": float(lo),
                "distance_km": round(haversine_km(lat, lon, float(la), float(lo)), 1),
                "last_update": iso_z(last),
                "sensors": sensors,
            }
        )
    return sorted(out, key=lambda s: s["distance_km"])


async def nearby(http: HttpClient, api_key: str | None, lat: float, lon: float) -> dict[str, Any]:
    if not api_key:
        return unavailable("Air quality needs a free OpenAQ API key (set ATLAS_OPENAQ_API_KEY).", "configure")
    now = utcnow()
    try:
        data = await _get(http, api_key, "/locations", {"coordinates": f"{lat:.4f},{lon:.4f}", "radius": RADIUS_M, "limit": 100})
    except FetchError as exc:
        return unavailable(f"OpenAQ did not respond ({exc}).", "retry")
    stations = fresh_stations(data.get("results") or [], lat, lon, now)[:MAX_STATIONS]
    if not stations:
        return {
            "status": "ok", "kind": "air_quality", "provenance": "real", "stations": [], "radius_km": RADIUS_M / 1000,
            "note": "No monitoring station within 25 km reported in the last 24 hours.", "attribution": "Air quality data: OpenAQ",
            "computed_at": iso_z(now),
        }  # fmt: skip
    for st in stations:
        try:
            latest = await _get(http, api_key, f"/locations/{int(st['id'])}/latest")
        except FetchError:
            st["readings"] = []
            st.pop("sensors", None)
            continue
        readings = []
        for r in latest.get("results") or []:
            sensor = st["sensors"].get(r.get("sensorsId"))
            when = parse_iso((r.get("datetime") or {}).get("utc"))
            value = r.get("value")
            if not sensor or when is None or not isinstance(value, (int, float)) or value < 0 or now - when > FRESH:
                continue
            readings.append(
                {
                    "parameter": sensor[0],
                    "label": PARAMETERS[sensor[0]],
                    "value": round(float(value), 1),
                    "unit": sensor[1],
                    "at": iso_z(when),
                }
            )
        order = list(PARAMETERS)
        st["readings"] = sorted(readings, key=lambda x: order.index(x["parameter"]))
        st.pop("sensors", None)
    stations = [s for s in stations if s.get("readings")]
    providers = sorted({s["provider"] for s in stations if s.get("provider")})
    return {
        "status": "ok",
        "kind": "air_quality",
        "provenance": "real",
        "radius_km": RADIUS_M / 1000,
        "stations": stations,
        "note": NOTE,
        "attribution": "Air quality data: OpenAQ" + (f" — providers: {', '.join(providers)}" if providers else ""),
        "computed_at": iso_z(now),
    }
