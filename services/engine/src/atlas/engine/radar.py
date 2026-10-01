"""Radar flood mapping with Sentinel-1 (DERIVED). Radar sees through cloud, so floods can be
mapped during the storm that causes them, when optical satellites see only cloud tops.

Data: Sentinel-1 radiometrically terrain-corrected (RTC) backscatter on Microsoft's Planetary
Computer (CC BY 4.0, processed by Catalyst from ESA GRD), read through anonymous, short-lived
access tokens. Only a window around the incident is read from the cloud-optimised GeoTIFFs.

Method: the newest pass since onset is compared with the pass before onset from the same
relative orbit (identical viewing geometry), so differences come from the ground, not the
angle. VV backscatter is smoothed with a 5×5 mean in linear power to suppress speckle, then
converted to dB; open water reflects the radar away from the satellite and appears dark, so
pixels below −18 dB are classed as water. "New water" is water after that was not water before.
Only land is analysed: calm sea after a windy day turns dark exactly like new water, so the sea
is masked with Natural Earth 1:10m land outlines (public domain, fetched once into the Core Pack)
plus a 500 m coastal margin, because generalised coastlines and harbours would otherwise leak sea.
"""

from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import numpy as np
import orjson

from atlas.http.client import HttpClient
from atlas.util.timeutil import iso_z, parse_iso

log = logging.getLogger("atlas.radar")

STAC_SEARCH = "https://planetarycomputer.microsoft.com/api/stac/v1/search"
TOKEN_URL = "https://planetarycomputer.microsoft.com/api/sas/v1/token/sentinel-1-rtc"  # noqa: S105 - a public endpoint, not a secret
COLLECTION = "sentinel-1-rtc"
BLOB_HOST = "sentinel1euwestrtc.blob.core.windows.net"
WATER_DB = -18.0
SMOOTH = 5
LAND_URL = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_land.geojson"
LAND_FILE = "land_10m.geojson"
COAST_MARGIN_M = 500  # generalised coastlines and harbours: leave a margin of sea-side doubt


@dataclass
class RadarPass:
    items: list[dict[str, Any]]
    when: datetime
    platform: str
    relative_orbit: int | None
    orbit_state: str | None

    def meta(self, valid_fraction: float) -> dict[str, Any]:
        return {
            "id": self.items[0]["id"],
            "tiles": [],
            "scene_cloud_cover": None,  # radar sees through cloud
            "window_valid_fraction": round(valid_fraction, 3),
            "datetime": iso_z(self.when),
            "platform": self.platform,
            "relative_orbit": self.relative_orbit,
            "orbit_state": self.orbit_state,
            "items": [it["id"] for it in self.items],
        }


def _safe_href(href: object) -> str | None:
    if not isinstance(href, str):
        return None
    parts = urlsplit(href)
    return href if parts.scheme == "https" and parts.hostname == BLOB_HOST and not parts.query else None


def group_passes(items: list[dict[str, Any]]) -> list[RadarPass]:
    """Items of one satellite pass (platform, relative orbit, day) are mosaicked together."""
    groups: dict[tuple[str, Any, str], list[dict[str, Any]]] = {}
    for it in items:
        p = it.get("properties") or {}
        when = parse_iso(p.get("datetime"))
        if when is None or _safe_href(((it.get("assets") or {}).get("vv") or {}).get("href")) is None:
            continue
        key = (str(p.get("platform")), p.get("sat:relative_orbit"), when.strftime("%Y-%m-%d"))
        groups.setdefault(key, []).append(it)
    out = []
    for (platform, orbit, _day), its in groups.items():
        p0 = its[0].get("properties") or {}
        out.append(
            RadarPass(
                items=its,
                when=min(parse_iso((i.get("properties") or {}).get("datetime")) or datetime.max for i in its),
                platform=platform,
                relative_orbit=orbit if isinstance(orbit, int) else None,
                orbit_state=p0.get("sat:orbit_state"),
            )
        )
    return sorted(out, key=lambda x: x.when)


def choose_pair(passes: list[RadarPass], onset: datetime) -> tuple[RadarPass, RadarPass] | None:
    """Newest pass since onset, and the latest earlier pass from the same relative orbit."""
    after = [p for p in passes if p.when >= onset]
    before = [p for p in passes if p.when < onset]
    for post in sorted(after, key=lambda p: p.when, reverse=True):
        same = [p for p in before if p.relative_orbit == post.relative_orbit and p.orbit_state == post.orbit_state]
        if same:
            return max(same, key=lambda p: p.when), post
    return None


async def search(http: HttpClient, bbox: tuple[float, float, float, float], start: datetime, end: datetime) -> list[RadarPass]:
    params: dict[str, str | int | float] = {
        "collections": COLLECTION,
        "bbox": ",".join(f"{v:.5f}" for v in bbox),
        "datetime": f"{start:%Y-%m-%dT%H:%M:%SZ}/{end:%Y-%m-%dT%H:%M:%SZ}",
        "limit": 100,
    }
    res = await http.get(STAC_SEARCH, params=params, ttl=timedelta(minutes=30), source_id="planetary-computer",
                         max_bytes=16 * 1024 * 1024, timeout_s=40)  # fmt: skip
    data = orjson.loads(res.content)
    feats = data.get("features") if isinstance(data, dict) else None
    return group_passes(feats if isinstance(feats, list) else [])


async def token(http: HttpClient) -> str:
    # Tokens last about 45 minutes; caching for 15 keeps every read inside a valid token.
    res = await http.get(TOKEN_URL, ttl=timedelta(minutes=15), source_id="planetary-computer")
    tok = orjson.loads(res.content).get("token")
    if not isinstance(tok, str) or not tok or "&" not in tok:
        raise ValueError("no access token")
    return tok


def box_mean(a: np.ndarray, k: int = SMOOTH) -> np.ndarray:
    """k×k mean ignoring NaNs (edges use the pixels available)."""
    pad = k // 2
    valid = np.isfinite(a)
    filled = np.where(valid, a, 0.0)
    s = np.pad(filled, pad).cumsum(0).cumsum(1)
    c = np.pad(valid.astype(float), pad).cumsum(0).cumsum(1)
    s = np.pad(s, ((1, 0), (1, 0)))
    c = np.pad(c, ((1, 0), (1, 0)))
    h, w = a.shape
    tot = s[k : k + h, k : k + w] - s[:h, k : k + w] - s[k : k + h, :w] + s[:h, :w]
    cnt = c[k : k + h, k : k + w] - c[:h, k : k + w] - c[k : k + h, :w] + c[:h, :w]
    with np.errstate(invalid="ignore", divide="ignore"):
        out: np.ndarray = tot / cnt
    out[~valid] = np.nan
    return out


def to_db(linear: np.ndarray) -> np.ndarray:
    with np.errstate(divide="ignore", invalid="ignore"):
        return 10.0 * np.log10(np.where(linear > 0, linear, np.nan))


def grey(db: np.ndarray) -> np.ndarray:
    """Backscatter as an 8-bit greyscale picture (−25 dB black … 0 dB white)."""
    v = np.clip((db + 25.0) / 25.0, 0, 1)
    img = np.nan_to_num(v * 255, nan=12).astype(np.uint8)
    return np.dstack([img, img, img])


class Land:
    """Natural Earth 1:10m land polygons with a spatial index, for masking the sea."""

    def __init__(self, path: Path) -> None:
        from shapely import STRtree
        from shapely.geometry import shape

        geoms = []
        for f in json.loads(path.read_text("utf-8")).get("features", []):
            try:
                geoms.extend(_polygons(shape(f["geometry"])))
            except (KeyError, TypeError, ValueError, AttributeError) as exc:
                log.debug("skipping a land polygon: %s", exc)
        self.geoms = geoms
        self.tree = STRtree(geoms)

    def mask(self, bbox: tuple[float, float, float, float], width: int, height: int) -> np.ndarray:
        """True for grid cells whose centre is on land."""
        import shapely
        from shapely.geometry import box
        from shapely.ops import unary_union

        w, s, e, n = bbox
        hits = [self.geoms[int(i)] for i in self.tree.query(box(w, s, e, n))]
        if not hits:
            return np.zeros((height, width), bool)
        land = unary_union(hits).intersection(box(w, s, e, n))
        xs = w + (np.arange(width) + 0.5) * (e - w) / width
        ys = n - (np.arange(height) + 0.5) * (n - s) / height
        gx, gy = np.meshgrid(xs, ys)
        result: np.ndarray = shapely.contains_xy(land, gx, gy)
        return result


def _polygons(g: Any) -> list[Any]:
    if g.geom_type == "Polygon":
        return [g]
    if g.geom_type == "MultiPolygon":
        return list(g.geoms)
    return []


_land: Land | None = None
_land_lock = asyncio.Lock()


async def land(http: HttpClient, core_dir: Path | None) -> Land | None:
    global _land
    if core_dir is None:
        return None
    async with _land_lock:
        if _land is None:
            path = core_dir / LAND_FILE
            if not path.exists():
                try:
                    await http.download(LAND_URL, path, max_bytes=24 << 20)
                except Exception as exc:
                    log.info("land outlines unavailable: %s", exc)
                    return None
            _land = await asyncio.to_thread(Land, path)
    return _land


CAVEATS = [
    "Smooth surfaces such as tarmac, sand and calm water all look dark to radar; dry sand and runways can be mistaken for water.",
    "Flooded vegetation and flooded towns often look brighter, not darker, so they are frequently missed.",
    "Wind roughens open water and can hide it; radar shadow on steep slopes can look like water.",
    "The −18 dB threshold is a common default, not calibrated for this place.",
]


RADAR_GDAL_ENV = {"CPL_VSIL_CURL_ALLOWED_EXTENSIONS": ".tif,.tiff"}


def _read_vv(pass_: RadarPass, tok: str, grid: Any) -> np.ndarray:
    from atlas.engine import spectral

    out: np.ndarray | None = None
    for it in pass_.items:
        href = _safe_href(it["assets"]["vv"]["href"])
        if href is None:
            continue
        arr = spectral._read(f"{href}?{tok}", grid, nearest=False, env=RADAR_GDAL_ENV).astype(np.float64)
        out = arr if out is None else np.where(out == 0, arr, out)
    if out is None:
        raise spectral.SpectralUnavailable("No readable Sentinel-1 data for this window.", retry=True)
    out[out <= 0] = np.nan
    return out


def run(spec: Any, grid: Any, before: RadarPass, after: RadarPass, tok: str, land_mask: np.ndarray | None) -> dict[str, Any]:
    """Blocking part (rasterio): read, smooth, threshold and classify."""
    from concurrent.futures import ThreadPoolExecutor

    from atlas.engine import spectral

    with ThreadPoolExecutor(max_workers=2) as pool:
        f_pre = pool.submit(_read_vv, before, tok, grid)
        f_post = pool.submit(_read_vv, after, tok, grid)
        pre_lin, post_lin = f_pre.result(), f_post.result()
    pre_db, post_db = to_db(box_mean(pre_lin)), to_db(box_mean(post_lin))
    covered = np.isfinite(pre_db) & np.isfinite(post_db)
    if covered.mean() < 0.2:
        raise spectral.SpectralUnavailable("The radar passes cover too little of this area to compare.")
    if land_mask is not None:
        k = max(3, 2 * round(COAST_MARGIN_M / grid.res_m) + 1)
        inland = box_mean(np.where(land_mask, 1.0, 0.0), k) > 0.999  # land at least COAST_MARGIN_M from the sea
        valid = covered & inland
    else:
        valid = covered
    if not valid.any():
        raise spectral.SpectralUnavailable("This window is open sea; radar water mapping here covers land only.")
    # classify() reads "> 0" as water, so pass the margin below the threshold
    classes, rgba = spectral.classify(spec, WATER_DB - pre_db, WATER_DB - post_db, valid, grid.row_area_km2())
    return {
        "payload": {
            "before": before.meta(float(np.isfinite(pre_lin).mean())),
            "after": after.meta(float(np.isfinite(post_lin).mean())),
            "valid_fraction": round(float(valid.mean()), 3),
            "land_fraction": round(float(land_mask.mean()), 3) if land_mask is not None else None,
            "classes": classes,
            "headline": spectral.headline(spec, classes),
        },
        "files": {
            "before.jpg": spectral.jpeg_rgb(grey(to_db(pre_lin))),
            "after.jpg": spectral.jpeg_rgb(grey(to_db(post_lin))),
            "change.png": spectral.png_rgba(rgba),
        },
    }
