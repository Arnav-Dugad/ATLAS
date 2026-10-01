"""What's here? — facts about any point on Earth, for the globe's right-click card.

* Elevation: Copernicus DEM GLO-30 (30 m) cloud-optimised GeoTIFFs on AWS Open Data, one
  pixel read per query. Tiles exist only for land; a missing tile means open water.
  The URL is built from the rounded coordinates against one fixed host, never from input text.
* Time zone: Natural Earth 1:10m time zones (public domain), downloaded once into the Core
  Pack folder on first use. Gives the standard UTC offset only: Natural Earth's example zone
  names are just one zone with that offset (China's polygon says Australia/Perth), so no
  daylight-saving rules can be derived from them, and none are claimed.
* Nearest place and residents within 10 km reuse the geocoder and the GHSL grid.
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
from functools import lru_cache
from pathlib import Path
from typing import Any

from atlas.http.client import HttpClient

log = logging.getLogger("atlas.point")

DEM_HOST = "copernicus-dem-30m.s3.amazonaws.com"
DEM_ATTRIBUTION = (
    "Copernicus DEM GLO-30 © DLR e.V. 2010–2014 and © Airbus Defence and Space GmbH 2014–2018, "
    "provided under COPERNICUS by the European Union and ESA"
)
TZ_URL = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_time_zones.geojson"
TZ_FILE = "time_zones_10m.geojson"

GDAL_ENV = {
    "GDAL_DISABLE_READDIR_ON_OPEN": "EMPTY_DIR",
    "CPL_VSIL_CURL_ALLOWED_EXTENSIONS": ".tif",
    "GDAL_HTTP_TIMEOUT": "20",
    "GDAL_HTTP_MAX_RETRY": "2",
    "GDAL_HTTP_USERAGENT": "ATLAS (open disaster intelligence; https://github.com/Arnav-Dugad/ATLAS)",
    "VSI_CACHE": "TRUE",
}


def dem_tile_url(lat: float, lon: float) -> str:
    la = math.floor(lat)
    lo = math.floor(lon)
    name = f"Copernicus_DSM_COG_10_{'N' if la >= 0 else 'S'}{abs(la):02d}_00_{'E' if lo >= 0 else 'W'}{abs(lo):03d}_00_DEM"
    return f"https://{DEM_HOST}/{name}/{name}.tif"


@lru_cache(maxsize=2048)
def _elevation(lat4: float, lon4: float) -> tuple[float | None, str]:
    """(metres, status) at a point rounded to ~10 m; status: 'ok', 'water' or 'unavailable'."""
    import rasterio
    from rasterio.errors import RasterioIOError
    from rasterio.windows import Window

    url = dem_tile_url(lat4, lon4)
    try:
        with rasterio.Env(**GDAL_ENV), rasterio.open(f"/vsicurl/{url}") as ds:
            row, col = ds.index(lon4, lat4)
            row = min(max(row, 0), ds.height - 1)
            col = min(max(col, 0), ds.width - 1)
            v = float(ds.read(1, window=Window(col, row, 1, 1))[0, 0])
            if ds.nodata is not None and v == ds.nodata:
                return None, "unavailable"
            return round(v, 1), "ok"
    except RasterioIOError as exc:
        if "404" in str(exc) or "does not exist" in str(exc) or "No such file" in str(exc):
            return None, "water"
        log.info("elevation unavailable at %s,%s: %s", lat4, lon4, exc)
        return None, "unavailable"


async def elevation(lat: float, lon: float) -> dict[str, Any]:
    value, status = await asyncio.to_thread(_elevation, round(lat, 4), round(lon, 4))
    note = {
        "ok": "Copernicus DEM GLO-30 (30 m surface model: includes buildings and trees)",
        "water": "Open water: the Copernicus DEM covers land only",
        "unavailable": "Elevation could not be read right now",
    }[status]
    return {"value_m": value, "status": status, "note": note, "provenance": "real" if status == "ok" else "unavailable"}


class TimeZones:
    def __init__(self, path: Path) -> None:
        from shapely import STRtree
        from shapely.geometry import shape

        data = json.loads(path.read_text("utf-8"))
        self.geoms = []
        self.props: list[dict[str, Any]] = []
        for f in data.get("features", []):
            try:
                self.geoms.append(shape(f["geometry"]))
            except Exception as exc:  # a malformed polygon in the source
                log.debug("skipping a time-zone polygon: %s", exc)
                continue
            self.props.append(f.get("properties") or {})
        self.tree = STRtree(self.geoms)

    def lookup(self, lat: float, lon: float) -> dict[str, Any] | None:
        from shapely.geometry import Point

        p = Point(lon, lat)
        for i in self.tree.query(p):
            if self.geoms[int(i)].covers(p):
                pr = self.props[int(i)]
                return {"utc_offset_hours": pr.get("zone"), "label": pr.get("time_zone"), "places": pr.get("places")}
        return None


_tz: TimeZones | None = None
_tz_lock = asyncio.Lock()


async def time_zone(http: HttpClient | None, core_dir: Path, lat: float, lon: float) -> dict[str, Any] | None:
    global _tz
    path = core_dir / TZ_FILE
    async with _tz_lock:
        if _tz is None:
            if not path.exists():
                if http is None:
                    return None
                try:
                    await http.download(TZ_URL, path, max_bytes=8 << 20)
                except Exception as exc:
                    log.info("time zones unavailable: %s", exc)
                    return None
            _tz = await asyncio.to_thread(TimeZones, path)
    tz = _tz.lookup(lat, lon)
    if tz is None and abs(lat) <= 90:
        # Open ocean: nautical time, 15° of longitude per hour
        offset = round(lon / 15)
        tz = {"utc_offset_hours": offset, "label": f"UTC{offset:+d} (nautical)", "places": None}
    return tz
