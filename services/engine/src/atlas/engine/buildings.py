"""Building footprints near an incident from Overture Maps (DERIVED counts of mapped buildings).

DuckDB reads Overture's public GeoParquet release on AWS directly, filtering on each file's
bounding-box statistics, so only the relevant row groups are downloaded. The first query in a
session reads every file's footer (about a minute); DuckDB caches those, and later queries take
seconds. Counts are of mapped footprints (OpenStreetMap, Microsoft, Google and others merged by
Overture); coverage is uneven, and a footprint count is not a damage estimate.
"""

from __future__ import annotations

import logging
import math
import re
import threading
from datetime import timedelta
from typing import Any

import numpy as np

from atlas.http.client import HttpClient
from atlas.util.timeutil import iso_z, utcnow

log = logging.getLogger("atlas.buildings")

BUCKET = "overturemaps-us-west-2"
LIST_URL = f"https://{BUCKET}.s3.amazonaws.com/"
RINGS_KM = [1.0, 2.0, 5.0, 10.0]
RELEASE = re.compile(r"<Prefix>release/(\d{4}-\d{2}-\d{2}\.\d+)/</Prefix>")


async def latest_release(http: HttpClient) -> str:
    res = await http.get(
        LIST_URL, params={"list-type": 2, "prefix": "release/", "delimiter": "/"}, ttl=timedelta(days=1), source_id="overture"
    )
    found = sorted(RELEASE.findall(res.content.decode("utf-8", "replace")))
    if not found:
        raise ValueError("no Overture release listed")
    return str(found[-1])


class Buildings:
    def __init__(self) -> None:
        self._con: Any = None
        self._lock = threading.Lock()
        self.warm = False

    def _connect(self) -> Any:
        import duckdb

        if self._con is None:
            con = duckdb.connect()
            con.execute("INSTALL httpfs; LOAD httpfs;")
            con.execute("SET s3_region='us-west-2'; SET s3_access_key_id=''; SET s3_secret_access_key='';")
            con.execute("SET enable_http_metadata_cache=true; SET parquet_metadata_cache=true;")
            self._con = con
        return self._con

    def centroids(self, release: str, w: float, s: float, e: float, n: float) -> np.ndarray:
        """Bounding-box centres of every building intersecting the box (lon, lat columns)."""
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}\.\d+", release):
            raise ValueError("bad release name")
        path = f"s3://{BUCKET}/release/{release}/theme=buildings/type=building/*"
        q = (
            "SELECT (bbox.xmin + bbox.xmax) / 2 AS x, (bbox.ymin + bbox.ymax) / 2 AS y "
            "FROM read_parquet(?, hive_partitioning = 1) "
            "WHERE bbox.xmin <= ? AND bbox.xmax >= ? AND bbox.ymin <= ? AND bbox.ymax >= ?"
        )
        with self._lock:
            rows = self._connect().execute(q, [path, e, w, n, s]).fetchnumpy()
            self.warm = True
        return (
            np.column_stack([np.asarray(rows["x"], dtype=float), np.asarray(rows["y"], dtype=float)])
            if len(rows["x"])
            else np.zeros((0, 2))
        )

    def rings(self, release: str, lat: float, lon: float, rings_km: list[float]) -> dict[str, Any]:
        r = max(rings_km)
        dlat = r / 110.574
        dlon = r / (111.320 * max(0.05, math.cos(math.radians(lat))))
        pts = self.centroids(release, lon - dlon, lat - dlat, lon + dlon, lat + dlat)
        if len(pts):
            p1 = math.radians(lat)
            la = np.radians(pts[:, 1])
            a = np.sin((la - p1) / 2) ** 2 + math.cos(p1) * np.cos(la) * np.sin(np.radians(pts[:, 0] - lon) / 2) ** 2
            d = 2 * 6371.0088 * np.arcsin(np.minimum(1.0, np.sqrt(a)))
        else:
            d = np.zeros(0)
        return {
            "status": "ok",
            "provenance": "derived",
            "release": release,
            "rings": [{"radius_km": k, "buildings": int((d <= k).sum())} for k in rings_km],
            "computed_at": iso_z(utcnow()),
            "method": "Overture Maps building footprints whose bounding-box centre lies within each ring.",
            "attribution": "Buildings: Overture Maps Foundation (ODbL; includes © OpenStreetMap contributors, Microsoft and Google Open Buildings)",
            "limitations": "Mapped footprints only: coverage varies by country and source, and a count of buildings is not a count of damage.",
        }
