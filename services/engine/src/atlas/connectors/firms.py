"""NASA FIRMS active fire detections.

By default ATLAS uses the public global 24-hour files, which require no account. Each file
is ~1–8 MB; conditional requests mean unchanged files are never re-downloaded. If a free
MAP_KEY is configured, the same pipeline can request specific areas and historical days.
The CSVs are bulk-loaded by DuckDB directly from the HTTP cache, never parsed row-by-row
in Python.
"""

from __future__ import annotations

from datetime import timedelta

from atlas.connectors.base import (
    Capability,
    DataConnector,
    DetectionFile,
    FetchOutcome,
    Job,
)
from atlas.http.client import FetchError

PUBLIC = "https://firms.modaps.eosdis.nasa.gov/data/active_fire/{path}"

PRODUCTS: list[tuple[str, str, str, str]] = [
    # (product id, path, instrument, satellite hint)
    ("VIIRS_NOAA20_NRT", "noaa-20-viirs-c2/csv/J1_VIIRS_C2_Global_24h.csv", "VIIRS", "NOAA-20"),
    ("VIIRS_NOAA21_NRT", "noaa-21-viirs-c2/csv/J2_VIIRS_C2_Global_24h.csv", "VIIRS", "NOAA-21"),
    ("VIIRS_SNPP_NRT", "suomi-npp-viirs-c2/csv/SUOMI_VIIRS_C2_Global_24h.csv", "VIIRS", "Suomi NPP"),
    ("MODIS_NRT", "modis-c6.1/csv/MODIS_C6_1_Global_24h.csv", "MODIS", "Terra/Aqua"),
]


class FirmsConnector(DataConnector):
    id = "firms"
    name = "NASA FIRMS"
    capabilities = frozenset({Capability.LATEST, Capability.DETECTIONS})

    def jobs(self) -> list[Job]:
        return [Job("firms.global24h", timedelta(minutes=30), self.fetch_latest)]

    async def fetch_latest(self) -> FetchOutcome:
        out = FetchOutcome()
        for product, path, instrument, sat in PRODUCTS:
            try:
                res = await self.ctx.http.get(
                    PUBLIC.format(path=path), ttl=timedelta(minutes=25), source_id=self.id,
                    max_bytes=48 * 1024 * 1024,
                )  # fmt: skip
            except FetchError as exc:
                out.notes.append(f"{product}: {exc}")
                continue
            out.absorb(res)
            if res.cache_path is None or not res.content.startswith(b"latitude,"):
                out.notes.append(f"{product}: unexpected CSV header")
                out.rejected += 1
                continue
            out.detection_files.append(DetectionFile(res.cache_path, instrument, sat, product))
        if not out.detection_files:
            raise FetchError("no FIRMS product could be retrieved: " + "; ".join(out.notes))
        return out
