"""Exposure engine: what lies within reach of a hazard.

Both analyses are *descriptive*: they count people and mapped facilities inside distance
rings around an incident. They do not estimate damage, casualties or impact.

* Population — GHSL GHS-POP R2023A (2025 epoch, 30 arc-seconds ≈ 1 km). Grid cells whose
  centres fall inside each geodesic ring are summed (windowed raster reads; the 484 MB
  raster is never loaded whole). Provenance: MODEL (the grid is a modelled disaggregation of
  census data) aggregated by ATLAS.
* Infrastructure — OpenStreetMap via Overpass. Exact per-ring counts for 11 facility
  categories plus a list of named critical facilities. Provenance: DERIVED from crowd-sourced
  data whose completeness varies by country — absence of a mapped facility is not absence of
  the facility.
"""

from __future__ import annotations

import logging
import math
import threading
from dataclasses import dataclass
from datetime import timedelta
from pathlib import Path
from typing import Any

import numpy as np
import orjson

from atlas.http.client import FetchError, HttpClient
from atlas.models import Hazard
from atlas.util.geo import EARTH_RADIUS_KM, bbox_around, haversine_km
from atlas.util.timeutil import iso_z, utcnow

log = logging.getLogger("atlas.exposure")

OVERPASS = "https://overpass-api.de/api/interpreter"

RINGS_KM: dict[Hazard, list[float]] = {
    Hazard.EARTHQUAKE: [5, 10, 25, 50],
    Hazard.VOLCANO: [5, 10, 25, 50],
    Hazard.WILDFIRE: [5, 10, 25],
    Hazard.TROPICAL_CYCLONE: [25, 50, 100],
    Hazard.SEVERE_STORM: [25, 50, 100],
    Hazard.LANDSLIDE: [5, 10, 25],
    Hazard.TSUNAMI: [10, 25, 50],
}
AREA_HAZARDS = {Hazard.FLOOD, Hazard.DROUGHT, Hazard.SEA_LAKE_ICE, Hazard.DUST_HAZE}

POPULATION_NOTE = (
    "Residential population from a modelled 1 km grid (GHSL 2025). Night-time/residential, not daytime or seasonal "
    "population; cells are counted when their centre lies inside a ring."
)
INFRA_NOTE = (
    "Counts of facilities mapped in OpenStreetMap. Completeness varies strongly by country; absence of a mapped "
    "facility does not mean the facility does not exist."
)


def rings_for(hazard: Hazard) -> list[float] | None:
    if hazard in AREA_HAZARDS:
        return None
    return RINGS_KM.get(hazard, [5, 10, 25, 50])


# ----------------------------------------------------------------------------------- population
class PopulationGrid:
    """Thread-safe windowed reader over the GHSL population raster."""

    def __init__(self, path: Path) -> None:
        import rasterio

        self.path = path
        self._ds = rasterio.open(path)
        self._lock = threading.Lock()
        self.nodata = self._ds.nodata
        self.res_deg = abs(self._ds.transform.a)

    @classmethod
    def find(cls, pack_dir: Path) -> PopulationGrid | None:
        tifs = sorted(pack_dir.glob("*.tif")) if pack_dir.exists() else []
        if not tifs:
            return None
        try:
            return cls(tifs[0])
        except Exception as exc:  # corrupt or partial pack
            log.warning("population grid unavailable: %s", exc)
            return None

    def _read(self, west: float, south: float, east: float, north: float) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        from rasterio.windows import from_bounds

        with self._lock:
            win = from_bounds(west, south, east, north, transform=self._ds.transform).round_offsets().round_lengths()
            data = self._ds.read(1, window=win, boundless=True, fill_value=0, masked=False).astype(np.float64)
            t = self._ds.window_transform(win)
        rows, cols = data.shape
        lons = t.c + (np.arange(cols) + 0.5) * t.a
        lats = t.f + (np.arange(rows) + 0.5) * t.e
        if self.nodata is not None:
            data[data == self.nodata] = 0.0
        data[~np.isfinite(data) | (data < 0)] = 0.0
        return data, lats, lons

    def rings(self, lat: float, lon: float, rings_km: list[float]) -> list[float]:
        west, south, east, north = bbox_around(lat, lon, max(rings_km))
        parts = [(west, south, east, north)]
        if west > east:  # crosses the antimeridian
            parts = [(west, south, 180.0, north), (-180.0, south, east, north)]
        totals = [0.0] * len(rings_km)
        for w, s, e, n in parts:
            data, lats, lons = self._read(w, s, e, n)
            if data.size == 0:
                continue
            lat_g, lon_g = np.meshgrid(np.radians(lats), np.radians(lons), indexing="ij")
            p1, l1 = math.radians(lat), math.radians(lon)
            a = np.sin((lat_g - p1) / 2) ** 2 + math.cos(p1) * np.cos(lat_g) * np.sin((lon_g - l1) / 2) ** 2
            dist = 2 * EARTH_RADIUS_KM * np.arcsin(np.minimum(1.0, np.sqrt(a)))
            for i, r in enumerate(rings_km):
                totals[i] += float(data[dist <= r].sum())
        return totals


def population_exposure(grid: PopulationGrid | None, hazard: Hazard, lat: float, lon: float) -> dict[str, Any]:
    rings = rings_for(hazard)
    if rings is None:
        return _unavailable(
            "population", "Ring-based exposure is not meaningful for area hazards; polygon exposure is on the roadmap."
        )
    if grid is None:
        return _unavailable(
            "population",
            "Population Pack not installed. Install it with `pnpm engine packs install population-ghsl` (~484 MB, CC BY 4.0).",
            action="install-pack",
        )
    totals = grid.rings(lat, lon, rings)
    return {
        "status": "ok",
        "kind": "population",
        "provenance": "model",
        "method": "Sum of GHSL 30″ cells with centres inside each geodesic ring",
        "dataset": "GHS-POP R2023A · epoch 2025 · 30 arc-seconds (~1 km)",
        "source": "ghsl-pop",
        "attribution": "Schiavina M. et al. (2023): GHS-POP R2023A. European Commission, Joint Research Centre (JRC)",
        "centre": {"lat": lat, "lon": lon},
        "rings": [{"radius_km": r, "population": round(v)} for r, v in zip(rings, totals, strict=True)],
        "note": POPULATION_NOTE,
        "computed_at": iso_z(utcnow()),
    }


# ------------------------------------------------------------------------------- infrastructure
@dataclass(frozen=True)
class Category:
    key: str
    label: str
    selectors: tuple[str, ...]
    listed: bool  # include named facilities in the facility list


CATEGORIES: tuple[Category, ...] = (
    Category("hospital", "Hospitals", ('nwr["amenity"="hospital"]', 'nwr["healthcare"="hospital"]'), True),
    Category("clinic", "Clinics & doctors", ('nwr["amenity"~"^(clinic|doctors)$"]',), False),
    Category("fire_station", "Fire stations", ('nwr["amenity"="fire_station"]',), True),
    Category("police", "Police", ('nwr["amenity"="police"]',), False),
    Category("school", "Schools & universities", ('nwr["amenity"~"^(school|kindergarten|college|university)$"]',), False),
    Category(
        "shelter", "Shelters & assembly points", ('nwr["emergency"="assembly_point"]', 'nwr["social_facility"="shelter"]'), True
    ),
    Category("airport", "Airports", ('nwr["aeroway"="aerodrome"]',), True),
    Category("port", "Ports & harbours", ('nwr["landuse"="port"]', 'nwr["harbour"="yes"]', 'nwr["industrial"="port"]'), True),
    Category("power", "Power plants & substations", ('nwr["power"~"^(plant|substation)$"]',), False),
    Category("water", "Water & wastewater works", ('nwr["man_made"~"^(water_works|wastewater_plant)$"]',), True),
    Category("bridge", "Major road bridges", ('way["bridge"="yes"]["highway"~"^(motorway|trunk|primary)$"]',), False),
)
LIST_CAP = 800


def build_overpass_query(lat: float, lon: float, rings_km: list[float]) -> tuple[str, list[tuple[str, float]]]:
    """One Overpass request: per category, select within the largest ring once, then filter
    that set down for each smaller ring. Returns the query and the order of count outputs."""
    rings = sorted(rings_km, reverse=True)
    rmax_m = int(rings[0] * 1000)
    parts = ["[out:json][timeout:90];"]
    order: list[tuple[str, float]] = []
    for i, cat in enumerate(CATEGORIES):
        union = "".join(f"{sel}(around:{rmax_m},{lat:.5f},{lon:.5f});" for sel in cat.selectors)
        parts.append(f"({union})->.c{i};")
        for r in rings:
            if r == rings[0]:
                parts.append(f".c{i} out count;")
            else:
                parts.append(f"nwr.c{i}(around:{int(r * 1000)},{lat:.5f},{lon:.5f})->.c{i}r;.c{i}r out count;")
            order.append((cat.key, r))
    listed = "".join(f".c{i};" for i, c in enumerate(CATEGORIES) if c.listed)
    parts.append(f"({listed})->.k;.k out center tags qt {LIST_CAP};")
    return "".join(parts), order


def parse_overpass(payload: dict[str, Any], order: list[tuple[str, float]], lat: float, lon: float,
                   rings_km: list[float]) -> dict[str, Any]:  # fmt: skip
    elements = payload.get("elements") or []
    counts = [e for e in elements if e.get("type") == "count"]
    if len(counts) != len(order):
        raise ValueError(f"expected {len(order)} count outputs, got {len(counts)}")
    by_cat: dict[str, dict[float, int]] = {}
    for (key, r), c in zip(order, counts, strict=True):
        by_cat.setdefault(key, {})[r] = int((c.get("tags") or {}).get("total", 0))

    facilities = []
    for e in elements:
        if e.get("type") == "count":
            continue
        tags = e.get("tags") or {}
        flat = e.get("lat") if "lat" in e else (e.get("center") or {}).get("lat")
        flon = e.get("lon") if "lon" in e else (e.get("center") or {}).get("lon")
        if flat is None or flon is None:
            continue
        cat = _categorise(tags)
        if cat is None:
            continue
        facilities.append(
            {
                "category": cat,
                "name": tags.get("name:en") or tags.get("name") or None,
                "lat": round(float(flat), 5),
                "lon": round(float(flon), 5),
                "distance_km": round(haversine_km(lat, lon, float(flat), float(flon)), 2),
                "osm": f"{e.get('type')}/{e.get('id')}",
                "iata": tags.get("iata"),
                "beds": tags.get("beds"),
                "emergency": tags.get("emergency") == "yes" or None,
            }
        )
    facilities.sort(key=lambda f: f["distance_km"])
    rings = sorted(rings_km)
    categories = [
        {
            "key": c.key,
            "label": c.label,
            "counts": [by_cat.get(c.key, {}).get(r, 0) for r in rings],
        }
        for c in CATEGORIES
    ]
    return {
        "status": "ok",
        "kind": "infrastructure",
        "provenance": "derived",
        "method": "Overpass count of OSM features (nodes, ways, relations) per geodesic ring",
        "source": "osm-overpass",
        "attribution": "© OpenStreetMap contributors (ODbL)",
        "centre": {"lat": lat, "lon": lon},
        "rings_km": rings,
        "categories": categories,
        "facilities": facilities[:80],
        "facilities_truncated": len(facilities) >= LIST_CAP,
        "note": INFRA_NOTE,
        "computed_at": iso_z(utcnow()),
    }


def _categorise(tags: dict[str, str]) -> str | None:
    if tags.get("amenity") == "hospital" or tags.get("healthcare") == "hospital":
        return "hospital"
    if tags.get("amenity") == "fire_station":
        return "fire_station"
    if tags.get("emergency") == "assembly_point" or tags.get("social_facility") == "shelter":
        return "shelter"
    if tags.get("aeroway") == "aerodrome":
        return "airport"
    if tags.get("landuse") == "port" or tags.get("harbour") == "yes" or tags.get("industrial") == "port":
        return "port"
    if tags.get("man_made") in ("water_works", "wastewater_plant"):
        return "water"
    return None


async def infrastructure_exposure(http: HttpClient, hazard: Hazard, lat: float, lon: float) -> dict[str, Any]:
    rings = rings_for(hazard)
    if rings is None:
        return _unavailable(
            "infrastructure", "Ring-based exposure is not meaningful for area hazards; polygon exposure is on the roadmap."
        )
    # Round the centre to ~100 m so repeated requests share the 24 h cache entry.
    qlat, qlon = round(lat, 3), round(lon, 3)
    query, order = build_overpass_query(qlat, qlon, rings)
    try:
        res = await http.get(
            OVERPASS, params={"data": query}, ttl=timedelta(hours=24), source_id="osm-overpass",
            max_bytes=24 * 1024 * 1024, attempts=2, timeout_s=100,
        )  # fmt: skip
    except FetchError as exc:
        return _unavailable("infrastructure", f"OpenStreetMap Overpass did not respond ({exc}). Try again later.", action="retry")
    try:
        out = parse_overpass(orjson.loads(res.content), order, qlat, qlon, rings)
    except (orjson.JSONDecodeError, ValueError) as exc:
        remark = ""
        try:
            remark = str(orjson.loads(res.content).get("remark", ""))[:200]
        except orjson.JSONDecodeError:
            pass
        return _unavailable("infrastructure", f"Overpass returned an incomplete result ({remark or exc}).", action="retry")
    out["from_cache"] = res.from_cache or res.not_modified
    out["fetched_at"] = iso_z(res.fetched_at)
    return out


def _unavailable(kind: str, reason: str, action: str | None = None) -> dict[str, Any]:
    return {"status": "unavailable", "kind": kind, "provenance": "unavailable", "reason": reason, "action": action}
