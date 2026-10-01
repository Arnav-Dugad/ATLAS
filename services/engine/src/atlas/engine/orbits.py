"""Public orbit data and the aurora oval.

* Satellites: current two-line element sets (TLE) for the optical imaging missions whose
  pictures ATLAS uses for change analysis — Sentinel-2A/B/C and Landsat 8/9 — from CelesTrak
  (free, no key; CelesTrak asks clients not to re-download the same data more than every couple
  of hours, so they are cached for 6 h). The browser propagates them with SGP4 to draw ground
  tracks and predict the next overpass of an incident.
* Aurora: NOAA SWPC's OVATION Prime short-term forecast of aurora probability on a 1° grid
  (a model valid ~30–90 minutes ahead, attributed and labelled as such).
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any

import orjson

from atlas.http.client import FetchError, HttpClient
from atlas.util.timeutil import iso_z, utcnow

CELESTRAK = "https://celestrak.org/NORAD/elements/gp.php"
OVATION = "https://services.swpc.noaa.gov/json/ovation_aurora_latest.json"

# (NORAD catalogue number, mission, swath width km): what each mission images in one pass
MISSIONS: list[tuple[int, str, float]] = [
    (40697, "Sentinel-2", 290.0),  # Sentinel-2A
    (42063, "Sentinel-2", 290.0),  # Sentinel-2B
    (60989, "Sentinel-2", 290.0),  # Sentinel-2C
    (39084, "Landsat", 185.0),  # Landsat 8
    (49260, "Landsat", 185.0),  # Landsat 9
]


def parse_tle(text: str) -> list[dict[str, str]]:
    lines = [ln.rstrip() for ln in text.splitlines() if ln.strip()]
    out = []
    for i in range(0, len(lines) - 2, 3):
        name, l1, l2 = lines[i].strip(), lines[i + 1], lines[i + 2]
        if l1.startswith("1 ") and l2.startswith("2 ") and len(l1) >= 69 and len(l2) >= 69:
            out.append({"name": name, "line1": l1[:69], "line2": l2[:69]})
    return out


async def satellites(http: HttpClient) -> dict[str, Any]:
    """One request per satellite (CelesTrak answers the odd request with HTTP 500), keeping the rest."""
    sats: list[dict[str, Any]] = []
    errors: list[str] = []
    for norad, mission, swath in MISSIONS:
        try:
            res = await http.get(CELESTRAK, params={"CATNR": norad, "FORMAT": "TLE"}, ttl=timedelta(hours=6),
                                 source_id="celestrak", max_bytes=64 * 1024)  # fmt: skip
        except FetchError as exc:
            errors.append(f"{norad}: {exc}")
            continue
        for sat in parse_tle(res.content.decode("ascii", "replace"))[:1]:
            sats.append({**sat, "norad": norad, "mission": mission, "swath_km": swath})
    if not sats:
        raise FetchError("CelesTrak returned no orbits: " + "; ".join(errors))
    return {
        "status": "ok",
        "source": "celestrak",
        "satellites": sats,
        "fetched_at": iso_z(utcnow()),
        "attribution": "Orbits: CelesTrak (NORAD two-line elements)",
        "missing": errors,
        "method": "Positions are propagated in the browser with SGP4 (satellite.js); accurate to a few km for a few days.",
    }


async def aurora(http: HttpClient) -> dict[str, Any]:
    res = await http.get(OVATION, ttl=timedelta(minutes=10), source_id="swpc", max_bytes=4 * 1024 * 1024)
    data = orjson.loads(res.content)
    points = [[int(c[0]), int(c[1]), int(c[2])] for c in data.get("coordinates") or [] if len(c) >= 3 and c[2] and c[2] >= 3]
    return {
        "status": "ok",
        "source": "swpc",
        "observed_at": data.get("Observation Time"),
        "forecast_for": data.get("Forecast Time"),
        "points": points,
        "max_probability": max((p[2] for p in points), default=0),
        "provenance": "model",
        "attribution": "Aurora: NOAA SWPC OVATION Prime model (short-term forecast of aurora probability)",
    }
