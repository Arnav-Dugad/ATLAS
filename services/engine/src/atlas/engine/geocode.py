"""Offline reverse geocoder and gazetteer built on Natural Earth.

* Country lookup: point-in-polygon against 1:50m admin-0 polygons (STRtree), with a
  nearest-coastline fallback for offshore events ("off the coast of Japan").
* Place lookup: vectorised haversine against ~7,300 populated places to produce
  USGS-style descriptions ("84 km SSW of Kainantu, Papua New Guinea").
* Gazetteer: ranked name search for the command palette ("Go to Tokyo").

All results are DERIVED values; generalised boundaries make attribution within a few km
of a border approximate, which the API documents in limitations.
"""

from __future__ import annotations

import json
import logging
import math
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
from shapely import STRtree
from shapely.geometry import Point, shape
from shapely.geometry.base import BaseGeometry
from shapely.ops import nearest_points

from atlas.models import PlaceRef
from atlas.util.geo import (
    EARTH_RADIUS_KM,
    compass_point,
    haversine_km,
    initial_bearing_deg,
)

log = logging.getLogger("atlas.geocode")

OFFSHORE_MAX_KM = 400.0


@dataclass
class CountryHit:
    iso3: str | None
    name: str
    continent: str | None
    subregion: str | None
    offshore_km: float  # 0 when the point is inside the polygon


def _fold(text: str) -> str:
    return unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode().lower().strip()


class Geocoder:
    def __init__(self, countries_path: Path | None, places_path: Path | None, admin1_path: Path | None = None) -> None:
        self.available = False
        self._geoms: list[BaseGeometry] = []
        self._meta: list[dict[str, Any]] = []
        self._tree: STRtree | None = None
        self._admin1: list[tuple[BaseGeometry, str, str | None]] = []
        self._admin1_tree: STRtree | None = None
        self.place_names: list[str] = []
        self.place_meta: list[dict[str, Any]] = []
        self._plat = np.zeros(0)
        self._plon = np.zeros(0)
        self._ppop = np.zeros(0)
        if countries_path and countries_path.exists():
            self._load_countries(countries_path)
        if places_path and places_path.exists():
            self._load_places(places_path)
        if admin1_path and admin1_path.exists():
            self._load_admin1(admin1_path)
        self.available = self._tree is not None and len(self.place_meta) > 0

    # -- loading -----------------------------------------------------------------------
    def _load_countries(self, path: Path) -> None:
        data = json.loads(path.read_text("utf-8"))
        for f in data.get("features", []):
            p = f.get("properties") or {}
            try:
                geom = shape(f["geometry"])
            except (KeyError, ValueError, TypeError):
                continue
            iso3 = p.get("ISO_A3")
            if not iso3 or iso3 == "-99":
                iso3 = p.get("ADM0_A3") if p.get("ADM0_A3") not in (None, "-99") else None
            self._geoms.append(geom)
            self._meta.append(
                {
                    "iso3": iso3,
                    "name": p.get("NAME") or p.get("ADMIN") or "Unknown",
                    "continent": p.get("CONTINENT"),
                    "subregion": p.get("SUBREGION"),
                    "pop_est": p.get("POP_EST"),
                }
            )
        self._tree = STRtree(self._geoms)
        log.info("geocoder: %d countries", len(self._geoms))

    def _load_places(self, path: Path) -> None:
        data = json.loads(path.read_text("utf-8"))
        lats, lons, pops = [], [], []
        for f in data.get("features", []):
            p = f.get("properties") or {}
            coords = (f.get("geometry") or {}).get("coordinates") or []
            if len(coords) < 2 or not p.get("name"):
                continue
            lats.append(float(coords[1]))
            lons.append(float(coords[0]))
            pops.append(float(p.get("pop_max") or 0))
            self.place_names.append(_fold(str(p.get("nameascii") or p["name"])))
            self.place_meta.append(
                {
                    "name": p["name"],
                    "country": p.get("adm0name"),
                    "country_iso3": p.get("adm0_a3"),
                    "admin1": p.get("adm1name"),
                    "population": int(p.get("pop_max") or 0) or None,
                    "capital": (p.get("featurecla") or "").startswith("Admin-0 capital"),
                    "scalerank": p.get("scalerank"),
                }
            )
        self._plat = np.radians(np.array(lats))
        self._plon = np.radians(np.array(lons))
        self._ppop = np.array(pops)
        self._lat_deg = np.array(lats)
        self._lon_deg = np.array(lons)
        log.info("geocoder: %d populated places", len(self.place_meta))

    def _load_admin1(self, path: Path) -> None:
        data = json.loads(path.read_text("utf-8"))
        geoms = []
        for f in data.get("features", []):
            p = f.get("properties") or {}
            try:
                geom = shape(f["geometry"])
            except (KeyError, ValueError, TypeError):
                continue
            self._admin1.append((geom, p.get("name") or "", p.get("adm0_a3")))
            geoms.append(geom)
        if geoms:
            self._admin1_tree = STRtree(geoms)

    # -- queries -----------------------------------------------------------------------
    def country(self, lat: float, lon: float) -> CountryHit | None:
        if self._tree is None:
            return None
        pt = Point(lon, lat)
        for idx in self._tree.query(pt, predicate="intersects"):
            m = self._meta[int(idx)]
            return CountryHit(m["iso3"], m["name"], m["continent"], m["subregion"], 0.0)
        idx = self._tree.nearest(pt)
        if idx is None:
            return None
        geom = self._geoms[int(idx)]
        near = nearest_points(geom, pt)[0]
        dist = haversine_km(lat, lon, near.y, near.x)
        if dist > OFFSHORE_MAX_KM:
            return None
        m = self._meta[int(idx)]
        return CountryHit(m["iso3"], m["name"], m["continent"], m["subregion"], round(dist, 1))

    def admin1(self, lat: float, lon: float) -> str | None:
        if self._admin1_tree is None:
            return None
        pt = Point(lon, lat)
        for idx in self._admin1_tree.query(pt, predicate="intersects"):
            return self._admin1[int(idx)][1] or None
        return None

    def _distances(self, lat: float, lon: float) -> np.ndarray:
        p1 = math.radians(lat)
        l1 = math.radians(lon)
        dp = self._plat - p1
        dl = self._plon - l1
        a = np.sin(dp / 2) ** 2 + math.cos(p1) * np.cos(self._plat) * np.sin(dl / 2) ** 2
        return 2 * EARTH_RADIUS_KM * np.arcsin(np.minimum(1.0, np.sqrt(a)))

    def nearest_places(self, lat: float, lon: float, *, k: int = 5, min_population: int = 0,
                       max_km: float = 2000.0) -> list[PlaceRef]:  # fmt: skip
        if not self.place_meta:
            return []
        d = self._distances(lat, lon)
        if min_population:
            d = np.where(self._ppop >= min_population, d, np.inf)
        order = np.argsort(d)[:k]
        out = []
        for i in order:
            if not np.isfinite(d[i]) or d[i] > max_km:
                continue
            out.append(self._place_ref(int(i), lat, lon, float(d[i])))
        return out

    def _place_ref(self, i: int, lat: float, lon: float, dist: float) -> PlaceRef:
        m = self.place_meta[i]
        plat, plon = float(self._lat_deg[i]), float(self._lon_deg[i])
        # Bearing *from the place to the event*, matching the "X km NE of City" convention.
        bearing = initial_bearing_deg(plat, plon, lat, lon)
        compass = compass_point(bearing)
        where = f"{m['name']}, {m['country']}" if m.get("country") else m["name"]
        desc = f"near {where}" if dist < 5 else f"{dist:.0f} km {compass} of {where}"
        return PlaceRef(
            name=m["name"], country=m.get("country"), country_iso3=m.get("country_iso3"), lat=plat, lon=plon,
            population=m.get("population"), distance_km=round(dist, 1), bearing_deg=round(bearing, 1),
            compass=compass, description=desc,
        )  # fmt: skip

    def describe(self, lat: float, lon: float) -> PlaceRef | None:
        """Best human reference: nearest town if close, else nearest sizeable city."""
        near = self.nearest_places(lat, lon, k=1)
        if near and near[0].distance_km <= 60:
            return near[0]
        big = self.nearest_places(lat, lon, k=1, min_population=100_000, max_km=1500)
        if big:
            return big[0]
        return near[0] if near else None

    def search(self, query: str, limit: int = 8) -> list[dict[str, Any]]:
        q = _fold(query)
        if len(q) < 2 or not self.place_meta:
            return []
        scored: list[tuple[float, int]] = []
        for i, name in enumerate(self.place_names):
            if name == q:
                rank = 3.0
            elif name.startswith(q):
                rank = 2.0
            elif q in name:
                rank = 1.0
            else:
                continue
            scored.append((rank + math.log10(max(self._ppop[i], 10.0)) / 10.0, i))
        scored.sort(reverse=True)
        out = []
        for score, i in scored[:limit]:
            m = self.place_meta[i]
            out.append(
                {
                    "kind": "place",
                    "name": m["name"],
                    "country": m.get("country"),
                    "admin1": m.get("admin1"),
                    "population": m.get("population"),
                    "lat": float(self._lat_deg[i]),
                    "lon": float(self._lon_deg[i]),
                    "score": round(score, 3),
                }
            )
        return out

    def search_countries(self, query: str, limit: int = 5) -> list[dict[str, Any]]:
        q = _fold(query)
        if len(q) < 2:
            return []
        out = []
        for geom, m in zip(self._geoms, self._meta, strict=True):
            name = _fold(m["name"])
            if name.startswith(q) or (m["iso3"] or "").lower() == q:
                c = geom.representative_point()
                minx, miny, maxx, maxy = geom.bounds
                out.append(
                    {
                        "kind": "country",
                        "name": m["name"],
                        "iso3": m["iso3"],
                        "lat": c.y,
                        "lon": c.x,
                        "bbox": [minx, miny, maxx, maxy],
                        "population": m.get("pop_est"),
                    }  # fmt: skip
                )
        out.sort(key=lambda r: -(r.get("population") or 0))
        return out[:limit]

    def country_bbox(self, iso3: str) -> tuple[float, float, float, float] | None:
        for geom, m in zip(self._geoms, self._meta, strict=True):
            if m["iso3"] == iso3:
                minx, miny, maxx, maxy = geom.bounds
                return (minx, miny, maxx, maxy)
        return None

    def country_name(self, iso3: str | None) -> str | None:
        if not iso3:
            return None
        for m in self._meta:
            if m["iso3"] == iso3:
                return str(m["name"])
        return None
