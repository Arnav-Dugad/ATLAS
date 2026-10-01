"""Geodesy helpers.

All distances use the WGS84 mean Earth radius (6371.0088 km) with the haversine formula.
Haversine error is <0.5% versus ellipsoidal geodesics, which is far below the positional
uncertainty of every hazard feed ATLAS ingests, and it is fast enough to run per-row.
"""

from __future__ import annotations

import math
from collections.abc import Iterable, Sequence

EARTH_RADIUS_KM = 6371.0088

COMPASS_16 = (
    "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
    "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
)  # fmt: skip


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_RADIUS_KM * math.asin(min(1.0, math.sqrt(a)))


def initial_bearing_deg(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Initial great-circle bearing from point 1 to point 2, degrees clockwise from north."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    x = math.sin(dl) * math.cos(p2)
    y = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(x, y)) + 360.0) % 360.0


def compass_point(bearing_deg: float) -> str:
    return COMPASS_16[round((bearing_deg % 360) / 22.5) % 16]


def destination_point(lat: float, lon: float, bearing_deg: float, distance_km: float) -> tuple[float, float]:
    d = distance_km / EARTH_RADIUS_KM
    b = math.radians(bearing_deg)
    p1, l1 = math.radians(lat), math.radians(lon)
    p2 = math.asin(math.sin(p1) * math.cos(d) + math.cos(p1) * math.sin(d) * math.cos(b))
    l2 = l1 + math.atan2(math.sin(b) * math.sin(d) * math.cos(p1), math.cos(d) - math.sin(p1) * math.sin(p2))
    return math.degrees(p2), normalize_lon(math.degrees(l2))


def normalize_lon(lon: float) -> float:
    return ((lon + 180.0) % 360.0) - 180.0


def valid_coordinate(lat: float | None, lon: float | None) -> bool:
    if lat is None or lon is None:
        return False
    if not (math.isfinite(lat) and math.isfinite(lon)):
        return False
    return -90.0 <= lat <= 90.0 and -180.0 <= lon <= 180.0


def bbox_of(points: Iterable[Sequence[float]]) -> tuple[float, float, float, float] | None:
    """Bounding box (west, south, east, north) for (lon, lat) points.

    Handles antimeridian-spanning point sets by choosing the narrower of the two
    possible longitude spans.
    """
    lons: list[float] = []
    lats: list[float] = []
    for p in points:
        lons.append(float(p[0]))
        lats.append(float(p[1]))
    if not lons:
        return None
    west, east = min(lons), max(lons)
    shifted = [lo + 360.0 if lo < 0 else lo for lo in lons]
    sw, se = min(shifted), max(shifted)
    if (se - sw) < (east - west):
        west, east = normalize_lon(sw), normalize_lon(se)
    return (west, min(lats), east, max(lats))


def bbox_contains(bbox: Sequence[float], lat: float, lon: float) -> bool:
    west, south, east, north = bbox
    if not (south <= lat <= north):
        return False
    if west <= east:
        return west <= lon <= east
    return lon >= west or lon <= east  # crosses the antimeridian


def bbox_around(lat: float, lon: float, radius_km: float) -> tuple[float, float, float, float]:
    """Conservative bbox that fully contains a circle of ``radius_km``."""
    dlat = math.degrees(radius_km / EARTH_RADIUS_KM)
    coslat = max(math.cos(math.radians(lat)), 1e-6)
    dlon = min(180.0, math.degrees(radius_km / (EARTH_RADIUS_KM * coslat)))
    return (
        normalize_lon(lon - dlon) if dlon < 180 else -180.0,
        max(-90.0, lat - dlat),
        normalize_lon(lon + dlon) if dlon < 180 else 180.0,
        min(90.0, lat + dlat),
    )


def circle_polygon(lat: float, lon: float, radius_km: float, segments: int = 72) -> list[list[float]]:
    """Geodesic circle as a closed GeoJSON ring of [lon, lat] pairs."""
    ring = [list(destination_point(lat, lon, 360.0 * i / segments, radius_km))[::-1] for i in range(segments)]
    ring.append(ring[0])
    return ring


def parse_hemisphere_coord(value: str) -> float:
    """Parse '19.2N' / '108.5W' style coordinates into signed decimal degrees."""
    v = value.strip().upper()
    if not v:
        raise ValueError("empty coordinate")
    sign = -1.0 if v[-1] in ("S", "W") else 1.0
    if v[-1] in ("N", "S", "E", "W"):
        v = v[:-1]
    return sign * float(v)
