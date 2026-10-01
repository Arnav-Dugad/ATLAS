"""WorldPop as a second opinion on population (MODEL): the same rings ATLAS counts with GHSL,
counted again by WorldPop's 2020 constrained 100 m model through its public stats API.

The two models differ by design (inputs, year and how people are placed in buildings), so the
comparison shows the spread between reasonable estimates, not which one is right.
"""

from __future__ import annotations

import asyncio
import math
from datetime import timedelta
from typing import Any

import orjson

from atlas.http.client import FetchError, HttpClient

STATS = "https://api.worldpop.org/v1/services/stats"
MAX_RING_KM = 100  # larger polygons time out on the public service


def ring_geojson(lat: float, lon: float, km: float, n: int = 48) -> str:
    d = km / 6371.0088
    p1, l1 = math.radians(lat), math.radians(lon)
    pts = []
    for i in range(n + 1):
        b = 2 * math.pi * i / n
        p2 = math.asin(math.sin(p1) * math.cos(d) + math.cos(p1) * math.sin(d) * math.cos(b))
        l2 = l1 + math.atan2(math.sin(b) * math.sin(d) * math.cos(p1), math.cos(d) - math.sin(p1) * math.sin(p2))
        pts.append([round(math.degrees(l2), 5), round(math.degrees(p2), 5)])
    fc = {
        "type": "FeatureCollection",
        "features": [{"type": "Feature", "properties": {}, "geometry": {"type": "Polygon", "coordinates": [pts]}}],
    }
    return orjson.dumps(fc).decode()


async def total(http: HttpClient, geojson: str) -> float | None:
    res = await http.get(STATS, params={"dataset": "wpgppop", "year": 2020, "runasync": "false", "geojson": geojson},
                         ttl=timedelta(days=30), source_id="worldpop", timeout_s=90, attempts=2)  # fmt: skip
    data = orjson.loads(res.content)
    if data.get("error"):
        raise ValueError(str(data.get("error_message") or "WorldPop error")[:200])
    value = (data.get("data") or {}).get("total_population")
    return float(value) if isinstance(value, (int, float)) else None


async def compare(http: HttpClient, lat: float, lon: float, rings_km: list[float], ghsl: list[float] | None) -> dict[str, Any]:
    rings = [r for r in rings_km if r <= MAX_RING_KM]
    sem = asyncio.Semaphore(2)

    async def one(km: float) -> float | None:
        async with sem:
            return await total(http, ring_geojson(lat, lon, km))

    results = await asyncio.gather(*(one(r) for r in rings), return_exceptions=True)
    rows = []
    errors = []
    for i, (km, res) in enumerate(zip(rings, results, strict=True)):
        if isinstance(res, (FetchError, ValueError, orjson.JSONDecodeError)):
            errors.append(f"{km:g} km: {res}")
            res = None
        elif isinstance(res, BaseException):
            raise res
        g = ghsl[i] if ghsl and i < len(ghsl) else None
        rows.append({"radius_km": km, "worldpop": round(res) if res is not None else None, "ghsl": round(g) if g is not None else None,
                     "ratio": round(res / g, 2) if res and g else None})  # fmt: skip
    return {
        "status": "ok",
        "provenance": "model",
        "rows": rows,
        "skipped_km": [r for r in rings_km if r > MAX_RING_KM],
        "errors": errors,
        "dataset": "WorldPop Global 2020, constrained to settlements, 100 m (wpgppop)",
        "attribution": "Population: WorldPop (www.worldpop.org), CC BY 4.0",
        "note": "Two population models differ by design (inputs, year, how people are placed); the spread is the uncertainty, not an error in one.",
    }
