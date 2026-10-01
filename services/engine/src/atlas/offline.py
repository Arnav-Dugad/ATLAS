"""Offline regions (Windows app): base imagery and terrain for a chosen area, saved on disk so the
globe keeps working without internet, and a local tile endpoint that serves saved tiles first.

* Tile sets are fixed here (Sentinel-2 cloudless, Blue Marble, Terrarium elevation); nothing in a
  request picks a URL. z/x/y are validated integers.
* A region is capped (tiles and area) and downloaded two tiles at a time with a pause between
  requests, so saving one never hammers the free tile services. Each region has its own folder,
  so deleting one never breaks another.
* Sentinel-2 cloudless tiles are EOX's, licensed for non-commercial use; saved copies stay on
  this computer.
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
import re
import shutil
import uuid
from dataclasses import asdict, dataclass, field
from datetime import timedelta
from pathlib import Path
from typing import Any

from atlas.http.client import FetchError, HttpClient
from atlas.util.timeutil import iso_z, utcnow

log = logging.getLogger("atlas.offline")


@dataclass(frozen=True)
class TileSet:
    url: str
    ext: str
    max_zoom: int
    source_id: str
    xyz: bool = True  # False: url uses {z}/{y}/{x}


TILESETS: dict[str, TileSet] = {
    "s2": TileSet("https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2024_3857/default/g/{z}/{y}/{x}.jpg", "jpg", 14, "eox-s2cloudless"),
    "bluemarble": TileSet(
        "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_ShadedRelief_Bathymetry/default//GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg",
        "jpeg", 8, "gibs",
    ),
    "terrain": TileSet("https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png", "png", 13, "terrain-tiles"),
}  # fmt: skip
MIME = {"jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png"}
MAX_TILES = 8000
MAX_AREA_DEG = 6.0  # longest side of a region
ID = re.compile(r"^[a-f0-9]{12}$")


def lon2x(lon: float, n: int) -> int:
    return max(0, min(n - 1, int((lon + 180.0) / 360.0 * n)))


def lat2y(lat: float, n: int) -> int:
    lat = max(-85.0511, min(85.0511, lat))
    r = math.radians(lat)
    return max(0, min(n - 1, int((1.0 - math.asinh(math.tan(r)) / math.pi) / 2.0 * n)))


def tiles_for(bbox: tuple[float, float, float, float], max_zoom: int) -> list[tuple[str, int, int, int]]:
    """Every (set, z, x, y) a region needs: imagery up to max_zoom, terrain up to min(max_zoom, 13)."""
    w, s, e, n_ = bbox
    out = []
    for name, ts in TILESETS.items():
        top = min(max_zoom, ts.max_zoom)
        for z in range(0, top + 1):
            n = 2**z
            for x in range(lon2x(w, n), lon2x(e, n) + 1):
                for y in range(lat2y(n_, n), lat2y(s, n) + 1):
                    out.append((name, z, x, y))
    return out


def estimate(bbox: tuple[float, float, float, float], max_zoom: int) -> dict[str, Any]:
    tiles = tiles_for(bbox, max_zoom)
    # measured averages: Sentinel-2 JPEG ~30 KB, Blue Marble ~20 KB, Terrarium PNG ~70 KB
    sizes = {"s2": 30_000, "bluemarble": 20_000, "terrain": 70_000}
    return {"tiles": len(tiles), "approx_mb": round(sum(sizes[t[0]] for t in tiles) / 1e6, 1)}


@dataclass
class Region:
    id: str
    name: str
    bbox: list[float]
    max_zoom: int
    tiles_total: int
    tiles_done: int = 0
    tiles_failed: int = 0
    bytes: int = 0
    status: str = "queued"  # queued | downloading | ready | error | cancelled
    created_at: str = field(default_factory=lambda: iso_z(utcnow()) or "")
    finished_at: str | None = None


class OfflineStore:
    def __init__(self, root: Path, http: HttpClient) -> None:
        self.root = root
        self.http = http
        self.regions_dir = root / "regions"
        self.manifest = root / "regions.json"
        self._regions: dict[str, Region] = {}
        self._tasks: dict[str, asyncio.Task[None]] = {}
        self._load()

    # -- manifest ------------------------------------------------------------------------
    def _load(self) -> None:
        if not self.manifest.is_file():
            return
        try:
            for r in json.loads(self.manifest.read_text("utf-8")):
                reg = Region(**r)
                if reg.status in ("queued", "downloading"):
                    reg.status = "error"  # interrupted by a restart; the user can save it again
                self._regions[reg.id] = reg
        except (OSError, ValueError, TypeError) as exc:
            log.warning("offline regions manifest unreadable: %s", exc)

    def _save(self) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        tmp = self.manifest.with_suffix(".tmp")
        tmp.write_text(json.dumps([asdict(r) for r in self._regions.values()], indent=1), "utf-8")
        tmp.replace(self.manifest)

    def list(self) -> list[dict[str, Any]]:
        return [asdict(r) for r in sorted(self._regions.values(), key=lambda r: r.created_at, reverse=True)]

    # -- tiles ---------------------------------------------------------------------------
    def _path(self, region: str, name: str, z: int, x: int, y: int) -> Path:
        return self.regions_dir / region / name / str(z) / str(x) / f"{y}.{TILESETS[name].ext}"

    def find(self, name: str, z: int, x: int, y: int) -> Path | None:
        for rid, reg in self._regions.items():
            if reg.status in ("ready", "downloading"):
                p = self._path(rid, name, z, x, y)
                if p.is_file():
                    return p
        return None

    async def fetch(self, name: str, z: int, x: int, y: int) -> bytes:
        ts = TILESETS[name]
        url = ts.url.format(z=z, x=x, y=y)
        res = await self.http.get(
            url, ttl=timedelta(days=30), source_id=ts.source_id, max_bytes=2 << 20, attempts=2, timeout_s=30
        )
        return res.content

    # -- regions -------------------------------------------------------------------------
    def create(self, name: str, bbox: tuple[float, float, float, float], max_zoom: int) -> Region:
        w, s, e, n = bbox
        if not (-180 <= w < e <= 180 and -85 <= s < n <= 85):
            raise ValueError("Choose an area within ±85° latitude that does not cross the antimeridian.")
        if max(e - w, n - s) > MAX_AREA_DEG:
            raise ValueError(f"Choose an area at most {MAX_AREA_DEG:g}° across (zoom in further).")
        if not 6 <= max_zoom <= 14:
            raise ValueError("Detail level must be between 6 and 14.")
        total = len(tiles_for(bbox, max_zoom))
        if total > MAX_TILES:
            raise ValueError(f"That needs {total:,} tiles; the limit is {MAX_TILES:,}. Zoom in or lower the detail.")
        reg = Region(
            id=uuid.uuid4().hex[:12],
            name=name.strip()[:60] or "Saved area",
            bbox=[w, s, e, n],
            max_zoom=max_zoom,
            tiles_total=total,
        )
        self._regions[reg.id] = reg
        self._save()
        self._tasks[reg.id] = asyncio.create_task(self._download(reg))
        return reg

    async def _download(self, reg: Region) -> None:
        reg.status = "downloading"
        self._save()
        sem = asyncio.Semaphore(2)
        tiles = tiles_for((reg.bbox[0], reg.bbox[1], reg.bbox[2], reg.bbox[3]), reg.max_zoom)

        async def one(t: tuple[str, int, int, int]) -> None:
            name, z, x, y = t
            dest = self._path(reg.id, name, z, x, y)
            async with sem:
                if not dest.is_file():
                    try:
                        data = await self.fetch(name, z, x, y)
                        dest.parent.mkdir(parents=True, exist_ok=True)
                        dest.write_bytes(data)
                        reg.bytes += len(data)
                    except FetchError as exc:
                        reg.tiles_failed += 1
                        log.debug("offline tile %s failed: %s", t, exc)
                    await asyncio.sleep(0.05)  # polite pacing
                reg.tiles_done += 1
                if reg.tiles_done % 100 == 0:
                    self._save()

        try:
            await asyncio.gather(*(one(t) for t in tiles))
            reg.status = "ready" if reg.tiles_failed < reg.tiles_total * 0.2 else "error"
        except asyncio.CancelledError:
            reg.status = "cancelled"
            raise
        finally:
            reg.finished_at = iso_z(utcnow())
            self._save()
            self._tasks.pop(reg.id, None)

    def delete(self, rid: str) -> bool:
        if not ID.match(rid) or rid not in self._regions:
            return False
        task = self._tasks.pop(rid, None)
        if task:
            task.cancel()
        self._regions.pop(rid)
        shutil.rmtree(self.regions_dir / rid, ignore_errors=True)
        self._save()
        return True
