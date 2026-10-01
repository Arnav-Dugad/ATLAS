"""Sentinel-2 change analysis around an incident (DERIVED data, Phase 3).

For one incident ATLAS finds a clear Sentinel-2 L2A pass before onset and the clearest pass
since, reads only the bands it needs for a small window around the incident (HTTP range reads
of the public cloud-optimised GeoTIFFs; no download of whole scenes), masks clouds, shadows,
snow and gaps with ESA's Scene Classification Layer, and maps change with a published index:

* wildfire: dNBR = NBR(before) - NBR(after), NBR = (B08 - B12) / (B08 + B12), classified with
  the USGS FIREMON burn-severity ranges (Key & Benson 2006).
* flood / tropical cyclone: MNDWI = (B03 - B11) / (B03 + B11) (Xu 2006); water where MNDWI > 0;
  "new water" is water after that was not water before.
* other hazards: NDVI = (B08 - B04) / (B08 + B04); |change| >= 0.2 is reported as a heuristic.

Every number is labelled DERIVED and carries the scenes, dates, valid-pixel share and caveats.
Nothing is extrapolated into masked areas.
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
import re
import struct
import zlib
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import numpy as np
import orjson

from atlas.http.client import HttpClient
from atlas.models import Hazard
from atlas.util.timeutil import iso_z, parse_iso, utcnow

log = logging.getLogger("atlas.spectral")

STAC_SEARCH = "https://earth-search.aws.element84.com/v1/search"
COLLECTION = "sentinel-2-l2a"
COG_HOST = "sentinel-cogs.s3.us-west-2.amazonaws.com"
METHOD = "atlas-spectral-v1"
CACHE_HOURS = 12
MAX_PX = 768
FILES = frozenset({"before.jpg", "after.jpg", "change.png"})
INCIDENT_ID = re.compile(r"^ATL-[A-Z]{2}-\d{4}-[A-Z0-9]{8}$")

# ESA L2A Scene Classification Layer
SCL_NODATA, SCL_DEFECTIVE, SCL_DARK, SCL_CLOUD_SHADOW, SCL_VEGETATION, SCL_BARE = 0, 1, 2, 3, 4, 5
SCL_WATER, SCL_UNCLASSIFIED, SCL_CLOUD_MEDIUM, SCL_CLOUD_HIGH, SCL_CIRRUS, SCL_SNOW = 6, 7, 8, 9, 10, 11


@dataclass(frozen=True)
class IndexSpec:
    id: str
    name: str
    bands: tuple[str, str]  # (a, b) of the normalised difference (a - b) / (a + b)
    band_names: tuple[str, str]
    valid_scl: frozenset[int]
    citation: str
    headline: str


INDICES: dict[str, IndexSpec] = {
    "nbr": IndexSpec(
        "nbr", "Burn severity (dNBR)", ("nir", "swir22"), ("B08", "B12"),
        # class 2 (dark area / topographic shadow) is kept: fresh burn scars are often dark
        frozenset({SCL_DARK, SCL_VEGETATION, SCL_BARE, SCL_UNCLASSIFIED}),
        "Key & Benson (2006), Landscape Assessment, FIREMON (USDA Forest Service RMRS-GTR-164-CD); USGS burn-severity ranges",
        "burned_area_km2",
    ),
    "mndwi": IndexSpec(
        "mndwi", "Surface water change (MNDWI)", ("green", "swir16"), ("B03", "B11"),
        frozenset({SCL_DARK, SCL_VEGETATION, SCL_BARE, SCL_WATER, SCL_UNCLASSIFIED}),
        "Xu (2006), Modification of normalised difference water index (NDWI), Int. J. Remote Sensing 27(14):3025-3033",
        "new_water_km2",
    ),
    "sar": IndexSpec(
        "sar", "Radar flood mapping (Sentinel-1)", ("vv", "vv"), ("VV", "VV"), frozenset(),
        "Sentinel-1 RTC VV backscatter below -18 dB as open water (a widely used threshold; e.g. Twele et al. 2016, "
        "Int. J. Remote Sensing 37(13):2990-3004), after a 5x5 speckle filter",
        "new_water_km2",
    ),
    "ndvi": IndexSpec(
        "ndvi", "Vegetation change (ΔNDVI)", ("nir", "red"), ("B08", "B04"),
        frozenset({SCL_VEGETATION, SCL_BARE, SCL_UNCLASSIFIED}),
        "Rouse et al. (1974); the ±0.2 change threshold is a common heuristic, not a calibrated standard",
        "vegetation_loss_km2",
    ),
}  # fmt: skip

INDEX_FOR_HAZARD: dict[str, str] = {"wildfire": "nbr", "flood": "mndwi", "tropical_cyclone": "mndwi"}

# Half-width of the analysis window when an incident has no footprint, in km.
HALF_KM: dict[str, float] = {"wildfire": 6, "flood": 15, "tropical_cyclone": 15, "volcano": 8, "earthquake": 10}

# (lower, upper, key, label, RGBA) — USGS FIREMON dNBR ranges
NBR_CLASSES: list[tuple[float, float, str, str, tuple[int, int, int, int]]] = [
    (-math.inf, -0.25, "regrowth_high", "Enhanced regrowth (high)", (26, 152, 80, 170)),
    (-0.25, -0.10, "regrowth_low", "Enhanced regrowth (low)", (145, 207, 96, 150)),
    (-0.10, 0.10, "unburned", "Unburned / unchanged", (0, 0, 0, 0)),
    (0.10, 0.27, "low", "Low severity", (255, 224, 102, 210)),
    (0.27, 0.44, "moderate_low", "Moderate-low severity", (253, 174, 97, 225)),
    (0.44, 0.66, "moderate_high", "Moderate-high severity", (244, 109, 67, 235)),
    (0.66, math.inf, "high", "High severity", (165, 0, 38, 245)),
]
NDVI_LOSS, NDVI_GAIN = -0.2, 0.2


class SpectralUnavailable(Exception):
    """Raised with a user-facing reason when no defensible analysis can be produced."""

    def __init__(self, reason: str, *, retry: bool = False) -> None:
        super().__init__(reason)
        self.reason = reason
        self.retry = retry


# -- geometry ---------------------------------------------------------------------------


def km_to_deg(lat: float, km_lat: float, km_lon: float) -> tuple[float, float]:
    return km_lat / 110.574, km_lon / (111.320 * max(0.05, math.cos(math.radians(lat))))


def analysis_window(hazard: str, lat: float, lon: float, bbox: list[float] | None) -> tuple[float, float, float, float]:
    """[w, s, e, n] around the incident: its footprint plus a margin, else a hazard-sized square.
    Capped at 40 km so a request stays a small, polite read."""
    if bbox and len(bbox) == 4 and bbox[2] > bbox[0] and bbox[3] > bbox[1]:
        w, s, e, n = bbox
        mlat, mlon = (n - s) * 0.15, (e - w) * 0.15
        w, s, e, n = w - mlon, s - mlat, e + mlon, n + mlat
        min_lat, min_lon = km_to_deg((s + n) / 2, 3, 3)
        cy, cx = (s + n) / 2, (w + e) / 2
        hy, hx = max((n - s) / 2, min_lat), max((e - w) / 2, min_lon)
    else:
        half = HALF_KM.get(hazard, 8.0)
        hy, hx = km_to_deg(lat, half, half)
        cy, cx = lat, lon
    max_lat, max_lon = km_to_deg(cy, 20, 20)
    hy, hx = min(hy, max_lat), min(hx, max_lon)
    return (round(cx - hx, 5), round(max(-84.0, cy - hy), 5), round(cx + hx, 5), round(min(84.0, cy + hy), 5))


@dataclass(frozen=True)
class Grid:
    bbox: tuple[float, float, float, float]
    width: int
    height: int
    res_m: float

    @staticmethod
    def for_bbox(bbox: tuple[float, float, float, float], max_px: int = MAX_PX, min_res_m: float = 10.0) -> Grid:
        w, s, e, n = bbox
        lat0 = math.radians((s + n) / 2)
        width_m = (e - w) * 111_320 * math.cos(lat0)
        height_m = (n - s) * 110_574
        res = max(min_res_m, max(width_m, height_m) / max_px)
        return Grid(bbox, max(1, round(width_m / res)), max(1, round(height_m / res)), res)

    def row_area_km2(self) -> np.ndarray:
        """Area of one pixel in each row (km²), accounting for latitude."""
        w, s, e, n = self.bbox
        dlon = (e - w) / self.width
        dlat = (n - s) / self.height
        lats = n - (np.arange(self.height) + 0.5) * dlat
        return (dlon * 111.320 * np.cos(np.radians(lats))) * (dlat * 110.574)


# -- catalogue -----------------------------------------------------------------------------


@dataclass
class Pass:
    """All Sentinel-2 items of one satellite pass (same platform and day) covering the window."""

    key: str
    datetime: datetime
    platform: str
    items: list[dict[str, Any]]

    @property
    def cloud_cover(self) -> float | None:
        vals = [it["properties"].get("eo:cloud_cover") for it in self.items]
        vals = [float(v) for v in vals if isinstance(v, int | float)]
        return round(sum(vals) / len(vals), 1) if vals else None

    def meta(self, valid: float) -> dict[str, Any]:
        return {
            "id": self.items[0]["id"],
            "items": [it["id"] for it in self.items],
            "datetime": iso_z(self.datetime),
            "platform": self.platform,
            "tiles": sorted(
                {str(it["properties"].get("grid:code") or it["properties"].get("s2:mgrs_tile") or "") for it in self.items}
            ),
            "scene_cloud_cover": self.cloud_cover,
            "window_valid_fraction": round(valid, 3),
        }


def _safe_href(href: object) -> str | None:
    if not isinstance(href, str):
        return None
    u = urlsplit(href)
    return href if u.scheme == "https" and (u.hostname or "").lower() == COG_HOST and u.path.endswith(".tif") else None


def _usable(item: dict[str, Any], bands: tuple[str, ...]) -> bool:
    assets = item.get("assets") or {}
    return all(_safe_href((assets.get(b) or {}).get("href")) for b in (*bands, "scl", "visual"))


def group_passes(items: list[dict[str, Any]], bands: tuple[str, ...]) -> list[Pass]:
    """Group catalogue items into passes; keep the latest processing of each tile."""
    best: dict[tuple[str, str, str], dict[str, Any]] = {}
    for it in items:
        if not isinstance(it, dict) or not _usable(it, bands):
            continue
        p = it.get("properties") or {}
        dt = parse_iso(p.get("datetime"))
        if dt is None:
            continue
        tile = str(p.get("grid:code") or p.get("s2:mgrs_tile") or it.get("id"))
        k = (str(p.get("platform", "")), dt.date().isoformat(), tile)
        prev = best.get(k)
        if prev is None or str(it.get("id")) > str(prev.get("id")):  # "_1_L2A" reprocessing sorts after "_0_L2A"
            best[k] = it
    passes: dict[tuple[str, str], Pass] = {}
    for (platform, day, _tile), it in best.items():
        dt = parse_iso(it["properties"]["datetime"])
        assert dt is not None
        ps = passes.setdefault((platform, day), Pass(f"{platform}:{day}", dt, platform, []))
        ps.items.append(it)
    return sorted(passes.values(), key=lambda p: p.datetime, reverse=True)


async def search_passes(
    http: HttpClient, bbox: tuple[float, float, float, float], start: datetime, end: datetime, bands: tuple[str, ...]
) -> list[Pass]:
    params: dict[str, str | int | float] = {
        "collections": COLLECTION,
        "bbox": ",".join(f"{v:.5f}" for v in bbox),
        "datetime": f"{iso_z(start)}/{iso_z(end)}",
        "limit": 60,
        "sortby": "-properties.datetime",
    }
    res = await http.get(
        STAC_SEARCH, params=params, ttl=timedelta(hours=1), source_id="earth-search", max_bytes=16 * 1024 * 1024, timeout_s=40
    )
    data = orjson.loads(res.content)
    feats = data.get("features") if isinstance(data, dict) else None
    return group_passes(feats if isinstance(feats, list) else [], bands)


# -- raster reading ----------------------------------------------------------------------------

GDAL_ENV = {
    "GDAL_DISABLE_READDIR_ON_OPEN": "EMPTY_DIR",
    "CPL_VSIL_CURL_ALLOWED_EXTENSIONS": ".tif",
    "GDAL_HTTP_TIMEOUT": "40",
    "GDAL_HTTP_MAX_RETRY": "3",
    "GDAL_HTTP_RETRY_DELAY": "1",
    "GDAL_HTTP_USERAGENT": "ATLAS/0.1 (open disaster intelligence; https://github.com/Arnav-Dugad/ATLAS)",
    "VSI_CACHE": "TRUE",
    "GDAL_HTTP_MERGE_CONSECUTIVE_RANGES": "YES",
}


def _read(href: str, grid: Grid, *, nearest: bool, bands: int | list[int] = 1, env: dict[str, str] | None = None) -> np.ndarray:
    """Warp a window of a remote COG onto the analysis grid, choosing the overview level whose
    resolution matches the grid so only the bytes needed are fetched."""
    import rasterio
    from rasterio.enums import Resampling
    from rasterio.transform import from_bounds
    from rasterio.vrt import WarpedVRT

    transform = from_bounds(*grid.bbox, grid.width, grid.height)
    with rasterio.Env(**{**GDAL_ENV, **(env or {})}):
        with rasterio.open(href) as probe:
            native = abs(probe.res[0])
            ovs = probe.overviews(1)
        level = None
        for i, factor in enumerate(ovs):
            if native * factor <= grid.res_m * 1.01:
                level = i
        opts: dict[str, Any] = {"overview_level": level} if level is not None else {}
        with rasterio.open(href, **opts) as src, WarpedVRT(
            src, crs="EPSG:4326", transform=transform, width=grid.width, height=grid.height,
            resampling=Resampling.nearest if nearest else Resampling.bilinear, src_nodata=0, nodata=0,
        ) as vrt:  # fmt: skip
            return vrt.read(bands)


def _mosaic(pass_: Pass, asset: str, grid: Grid, *, nearest: bool, bands: int | list[int] = 1) -> np.ndarray:
    out: np.ndarray | None = None
    for it in pass_.items:
        href = _safe_href(it["assets"][asset]["href"])
        if href is None:
            continue
        arr = _read(href, grid, nearest=nearest, bands=bands)
        if out is None:
            out = arr
        else:
            empty = out == 0
            out = np.where(empty, arr, out)
    if out is None:
        raise SpectralUnavailable("No readable Sentinel-2 data for this window.", retry=True)
    return out


def _scale(item: dict[str, Any], asset: str) -> tuple[float, float]:
    rb = (item["assets"][asset].get("raster:bands") or [{}])[0]
    return float(rb.get("scale", 0.0001)), float(rb.get("offset", 0.0))


def _reflectance(pass_: Pass, asset: str, grid: Grid) -> np.ndarray:
    dn = _mosaic(pass_, asset, grid, nearest=False).astype(np.float32)
    scale, offset = _scale(pass_.items[0], asset)
    refl = dn * scale + offset
    refl[dn == 0] = np.nan
    return np.clip(refl, 0.0, 1.5, out=refl)


def _nd(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    with np.errstate(divide="ignore", invalid="ignore"):
        out = (a - b) / (a + b)
    out[~np.isfinite(out)] = np.nan
    return out


# -- encoding ---------------------------------------------------------------------------------


def png_rgba(rgba: np.ndarray) -> bytes:
    """Minimal PNG encoder (8-bit RGBA) — no imaging dependency."""
    h, w, _ = rgba.shape
    raw = b"".join(b"\x00" + rgba[y].tobytes() for y in range(h))

    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 6))
        + chunk(b"IEND", b"")
    )


def jpeg_rgb(rgb: np.ndarray) -> bytes:
    """JPEG via GDAL (falls back to PNG bytes if the driver is unavailable)."""
    try:
        import rasterio
        from rasterio.io import MemoryFile

        h, w, _ = rgb.shape
        with rasterio.Env(), MemoryFile() as mem:
            with mem.open(driver="JPEG", width=w, height=h, count=3, dtype="uint8", QUALITY="82") as dst:
                dst.write(np.moveaxis(rgb, -1, 0))
            return bytes(mem.read())
    except Exception:  # pragma: no cover - driver availability differs by build
        alpha = np.full((*rgb.shape[:2], 1), 255, np.uint8)
        return png_rgba(np.concatenate([rgb, alpha], axis=2))


# -- classification ------------------------------------------------------------------------------


def classify(
    spec: IndexSpec, pre: np.ndarray, post: np.ndarray, valid: np.ndarray, area_row: np.ndarray
) -> tuple[list[dict[str, Any]], np.ndarray]:
    """Class areas and an RGBA change map. Pure function (unit-tested with synthetic arrays)."""
    h, w = valid.shape
    area = np.broadcast_to(area_row[:, None], (h, w))
    total = float(area[valid].sum()) or 1.0
    rgba = np.zeros((h, w, 4), np.uint8)
    classes: list[dict[str, Any]] = []

    def add(key: str, label: str, color: tuple[int, int, int, int], mask: np.ndarray) -> None:
        m = mask & valid
        a = float(area[m].sum())
        rgba[m] = color
        classes.append(
            {
                "key": key,
                "label": label,
                "color": "#{:02x}{:02x}{:02x}".format(*color[:3]),
                "area_km2": round(a, 3),
                "share": round(a / total, 4),
            }
        )

    if spec.id == "nbr":
        d = pre - post  # dNBR: positive where vegetation burned
        for lo, hi, key, label, color in NBR_CLASSES:
            add(key, label, color, (d >= lo) & (d < hi))
    elif spec.id in ("mndwi", "sar"):
        wpre, wpost = pre > 0, post > 0
        add("new_water", "New surface water", (56, 189, 248, 235), wpost & ~wpre)
        add("persistent_water", "Water on both dates", (30, 64, 175, 150), wpost & wpre)
        add("receded", "Water on the earlier date only", (202, 138, 4, 200), wpre & ~wpost)
        add("dry", "Dry on both dates", (0, 0, 0, 0), ~wpre & ~wpost)
    else:
        d = post - pre
        add("loss", "Vegetation loss (ΔNDVI ≤ −0.2)", (220, 38, 38, 220), d <= NDVI_LOSS)
        add("gain", "Vegetation gain (ΔNDVI ≥ +0.2)", (34, 197, 94, 180), d >= NDVI_GAIN)
        add("stable", "Little change", (0, 0, 0, 0), (d > NDVI_LOSS) & (d < NDVI_GAIN))
    rgba[~valid] = (0, 0, 0, 0)
    return classes, rgba


def headline(spec: IndexSpec, classes: list[dict[str, Any]]) -> dict[str, Any]:
    by = {c["key"]: c["area_km2"] for c in classes}
    if spec.id == "nbr":
        value = sum(by.get(k, 0.0) for k in ("low", "moderate_low", "moderate_high", "high"))
        return {"key": spec.headline, "label": "Burned area (dNBR ≥ 0.10)", "value": round(value, 2), "unit": "km²"}
    if spec.id in ("mndwi", "sar"):
        return {"key": spec.headline, "label": "New surface water", "value": round(by.get("new_water", 0.0), 2), "unit": "km²"}
    return {
        "key": spec.headline,
        "label": "Vegetation loss (ΔNDVI ≤ −0.2)",
        "value": round(by.get("loss", 0.0), 2),
        "unit": "km²",
    }


CAVEATS: dict[str, list[str]] = {
    "nbr": [
        "Burn severity is inferred from reflectance, not field-validated (no Composite Burn Index plots).",
        "Thin smoke, harvest, drought stress or a long gap between dates can mimic or mask burning.",
        "Fire that is still active may not have reached its final extent in the 'after' scene.",
    ],
    "mndwi": [
        "Optical satellites cannot see through clouds, which often cover floods; flooded vegetation and urban flooding are frequently missed.",
        "Seasonal rivers, reservoirs, tides and irrigation also change surface water.",
        "Radar sees through clouds: try the Sentinel-1 radar analysis when the optical view is cloudy.",
    ],
    "ndvi": [
        "Vegetation change also follows season, harvest, drought and phenology, not only the hazard.",
        "The ±0.2 threshold is a heuristic and is not calibrated for every landscape.",
    ],
}


# -- analysis -------------------------------------------------------------------------------------


def _valid_fraction(scl: np.ndarray, spec: IndexSpec) -> float:
    return float(np.isin(scl, list(spec.valid_scl)).mean()) if scl.size else 0.0


def prefer_clear(passes: list[Pass]) -> list[Pass]:
    """Stable re-ordering: scene cloud cover ≤ 20 %, then ≤ 50 %, then the rest."""

    def bucket(p: Pass) -> int:
        cc = p.cloud_cover
        return 1 if cc is None else 0 if cc <= 20 else 1 if cc <= 50 else 2

    return sorted(passes, key=bucket)


def _pick(
    passes: list[Pass], grid: Grid, spec: IndexSpec, max_tries: int, good: float, ok: float
) -> tuple[Pass, np.ndarray, float]:
    """First pass whose window is ≥ `good` clear, else the clearest ≥ `ok` among those tried.

    `passes` arrive in preference order (nearest to onset for "before", newest for "after");
    passes whose whole tile is mostly clear are tried first, because thin cloud and smoke that the
    scene classification misses still bias the index."""
    best: tuple[Pass, np.ndarray, float] | None = None
    tried = 0
    for p in prefer_clear(passes):
        if p.cloud_cover is not None and p.cloud_cover > 90:
            continue
        tried += 1
        scl = _mosaic(p, "scl", grid, nearest=True)
        frac = _valid_fraction(scl, spec)
        if frac >= good:
            return p, scl, frac
        if best is None or frac > best[2]:
            best = (p, scl, frac)
        if tried >= max_tries:
            break
    if best and best[2] >= ok:
        return best
    raise SpectralUnavailable(
        "No sufficiently clear Sentinel-2 view of this area in the search window (clouds, smoke or gaps).", retry=False
    )


def true_colour(pass_: Pass, grid: Grid, valid_scl: np.ndarray) -> np.ndarray:
    rgb = _mosaic(pass_, "visual", grid, nearest=False, bands=[1, 2, 3])
    img = np.moveaxis(rgb, 0, -1).astype(np.uint8)
    img[valid_scl == SCL_NODATA] = (8, 12, 18)
    return img


def run_analysis(
    spec: IndexSpec, grid: Grid, before: list[Pass], after: list[Pass], progress: Callable[[str], None] | None = None
) -> dict[str, Any]:
    """Blocking part (rasterio). Returns the result payload plus encoded images."""
    note = progress or (lambda _m: None)
    note("Checking cloud cover over the area")
    pre_pass, pre_scl, pre_valid = _pick(before, grid, spec, max_tries=6, good=0.8, ok=0.35)
    post_pass, post_scl, post_valid = _pick(after, grid, spec, max_tries=6, good=0.8, ok=0.35)
    note("Reading bands")
    a, b = spec.bands
    with ThreadPoolExecutor(max_workers=4) as pool:
        futs = {
            "pre_a": pool.submit(_reflectance, pre_pass, a, grid),
            "pre_b": pool.submit(_reflectance, pre_pass, b, grid),
            "post_a": pool.submit(_reflectance, post_pass, a, grid),
            "post_b": pool.submit(_reflectance, post_pass, b, grid),
            "pre_rgb": pool.submit(true_colour, pre_pass, grid, pre_scl),
            "post_rgb": pool.submit(true_colour, post_pass, grid, post_scl),
        }
        r = {k: f.result() for k, f in futs.items()}
    pre = _nd(r["pre_a"], r["pre_b"])
    post = _nd(r["post_a"], r["post_b"])
    valid = (
        np.isin(pre_scl, list(spec.valid_scl)) & np.isin(post_scl, list(spec.valid_scl)) & np.isfinite(pre) & np.isfinite(post)
    )
    classes, rgba = classify(spec, pre, post, valid, grid.row_area_km2())
    vf = float(valid.mean())
    if vf < 0.2:
        raise SpectralUnavailable("Too little of the area is clear on both dates to compare.")
    return {
        "payload": {
            "before": pre_pass.meta(pre_valid),
            "after": post_pass.meta(post_valid),
            "valid_fraction": round(vf, 3),
            "classes": classes,
            "headline": headline(spec, classes),
        },
        "files": {"before.jpg": jpeg_rgb(r["pre_rgb"]), "after.jpg": jpeg_rgb(r["post_rgb"]), "change.png": png_rgba(rgba)},
    }


def unavailable(reason: str, retry: bool = False) -> dict[str, Any]:
    return {
        "status": "unavailable",
        "kind": "spectral_change",
        "provenance": "unavailable",
        "reason": reason,
        "action": "retry" if retry else None,
    }


class SpectralService:
    """Caches results on disk (per incident and index) and serialises heavy reads."""

    def __init__(self, http: HttpClient, cache_dir: Path, *, offline: bool = False, core_dir: Path | None = None) -> None:
        self.http = http
        self.core_dir = core_dir
        self.root = cache_dir / "spectral"
        self.offline = offline

    def path(self, incident_id: str, index: str) -> Path:
        if not INCIDENT_ID.match(incident_id) or index not in INDICES:
            raise ValueError("invalid incident id or index")
        return self.root / incident_id / index

    def file(self, incident_id: str, index: str, name: str) -> Path | None:
        if name not in FILES:
            return None
        try:
            p = self.path(incident_id, index) / name
        except ValueError:
            return None
        return p if p.is_file() else None

    def cached(self, incident_id: str, index: str) -> dict[str, Any] | None:
        f = self.path(incident_id, index) / "result.json"
        if not f.is_file():
            return None
        data: dict[str, Any] = json.loads(f.read_text("utf-8"))
        computed = parse_iso(data.get("computed_at"))
        if computed is None or utcnow() - computed > timedelta(hours=CACHE_HOURS):
            return None
        return data

    async def analyse(
        self, incident_id: str, hazard: Hazard, lat: float, lon: float, bbox: list[float] | None, onset: datetime, index: str | None = None,
    ) -> dict[str, Any]:  # fmt: skip
        key = index if index in INDICES else INDEX_FOR_HAZARD.get(hazard.value, "ndvi")
        spec = INDICES[key]
        hit = self.cached(incident_id, key)
        if hit is not None:
            return hit
        if self.offline:
            return unavailable("Offline mode: Sentinel-2 analysis needs network access.")
        window = analysis_window(hazard.value, lat, lon, bbox)
        grid = Grid.for_bbox(window)
        now = utcnow()
        if spec.id == "sar":
            return await self._radar(incident_id, spec, window, grid, onset, now)
        try:
            before = await search_passes(
                self.http, window, onset - timedelta(days=45), onset - timedelta(hours=1), (*spec.bands, "scl", "visual")
            )
            after = await search_passes(self.http, window, onset, now, (*spec.bands, "scl", "visual"))
        except Exception as exc:  # network / catalogue errors
            log.warning("spectral: catalogue search failed for %s: %s", incident_id, exc)
            return unavailable("The Sentinel-2 catalogue (Earth Search) did not respond.", retry=True)
        if not before:
            return unavailable("No Sentinel-2 pass over this area in the 45 days before onset.")
        if not after:
            return unavailable(
                "No Sentinel-2 pass over this area since onset yet; the satellites revisit about every 5 days.", retry=True
            )
        try:
            result = await asyncio.to_thread(run_analysis, spec, grid, before, after)
        except SpectralUnavailable as exc:
            return unavailable(exc.reason, exc.retry)
        except Exception as exc:
            log.exception("spectral: analysis failed for %s", incident_id)
            return unavailable(f"Reading Sentinel-2 data failed ({type(exc).__name__}).", retry=True)

        year = utcnow().year
        payload = {
            "status": "ok",
            "kind": "spectral_change",
            "provenance": "derived",
            "incident_id": incident_id,
            "index": {
                "id": spec.id,
                "name": spec.name,
                "formula": f"({spec.band_names[0]} − {spec.band_names[1]}) / ({spec.band_names[0]} + {spec.band_names[1]})",
                "citation": spec.citation,
            },
            "available_indices": list(INDICES),
            "window": {"bbox": list(window), "resolution_m": round(grid.res_m, 1), "width": grid.width, "height": grid.height},
            **result["payload"],
            "images": {name: f"/api/v1/imagery/files/{incident_id}/{spec.id}/{name}" for name in sorted(FILES)},
            "caveats": CAVEATS[spec.id],
            "method": METHOD,
            "attribution": f"Contains modified Copernicus Sentinel data {year}, processed by ATLAS. Catalogue: Element 84 Earth Search (AWS Open Data).",
            "computed_at": iso_z(now),
        }
        await asyncio.to_thread(_store, self.path(incident_id, spec.id), result["files"], payload)
        return payload

    async def _radar(
        self,
        incident_id: str,
        spec: IndexSpec,
        window: tuple[float, float, float, float],
        grid: Grid,
        onset: datetime,
        now: datetime,
    ) -> dict[str, Any]:
        from atlas.engine import radar

        try:
            passes = await radar.search(self.http, window, onset - timedelta(days=60), now)
            tok = await radar.token(self.http)
        except Exception as exc:  # network / catalogue errors
            log.warning("radar: catalogue search failed for %s: %s", incident_id, exc)
            return unavailable("The Planetary Computer catalogue did not respond.", retry=True)
        land = await radar.land(self.http, self.core_dir)
        land_mask = land.mask(grid.bbox, grid.width, grid.height) if land is not None else None
        pair = radar.choose_pair(passes, onset)
        if pair is None:
            if not any(p.when >= onset for p in passes):
                return unavailable(
                    "No Sentinel-1 radar pass over this area since onset yet; passes come every few days.", retry=True
                )
            return unavailable("No earlier Sentinel-1 pass from the same orbit in the 60 days before onset to compare with.")
        try:
            result = await asyncio.to_thread(radar.run, spec, grid, pair[0], pair[1], tok, land_mask)
        except SpectralUnavailable as exc:
            return unavailable(exc.reason, exc.retry)
        except Exception as exc:
            log.exception("radar: analysis failed for %s", incident_id)
            return unavailable(f"Reading Sentinel-1 data failed ({type(exc).__name__}).", retry=True)
        payload = {
            "status": "ok",
            "kind": "spectral_change",
            "provenance": "derived",
            "incident_id": incident_id,
            "index": {
                "id": spec.id,
                "name": spec.name,
                "formula": f"VV backscatter < {radar.WATER_DB:g} dB → water",
                "citation": spec.citation,
            },
            "available_indices": list(INDICES),
            "window": {"bbox": list(window), "resolution_m": round(grid.res_m, 1), "width": grid.width, "height": grid.height},
            **result["payload"],
            "images": {name: f"/api/v1/imagery/files/{incident_id}/{spec.id}/{name}" for name in sorted(FILES)},
            "caveats": [
                *radar.CAVEATS,
                "The sea and a 500 m coastal margin are excluded (Natural Earth 1:10m land), so flooding right at the shore is not mapped."
                if land_mask is not None
                else "Land outlines were unavailable, so the sea is not masked: calm sea can appear as new water.",
            ],
            "method": "atlas-radar-v1",
            "attribution": (
                f"Contains modified Copernicus Sentinel data {now.year}; terrain correction by Catalyst; "
                "Microsoft Planetary Computer (CC BY 4.0). Processed by ATLAS."
            ),
            "computed_at": iso_z(now),
        }
        await asyncio.to_thread(_store, self.path(incident_id, spec.id), result["files"], payload)
        return payload


def _store(out: Path, files: dict[str, bytes], payload: dict[str, Any]) -> None:
    out.mkdir(parents=True, exist_ok=True)
    for name, data in files.items():
        (out / name).write_bytes(data)
    (out / "result.json").write_text(json.dumps(payload), "utf-8")
