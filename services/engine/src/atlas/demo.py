"""Demo Mode: cached *real* historical earthquake sequences from the USGS ComCat archive.

Nothing here is synthetic. Each entry is a USGS event id; the builder downloads the event and
every M4+ earthquake within 300 km during the following 7 days, so presentations work offline
and the replay engine can show how a sequence unfolded. Labels are curated names only — no
casualty or damage figures are added.
"""

from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass
from datetime import timedelta
from pathlib import Path
from typing import Any

import orjson

from atlas.config import REPO_ROOT, get_settings
from atlas.http.cache import HttpCache
from atlas.http.client import HttpClient
from atlas.http.security import UrlPolicy
from atlas.registry import load_registry
from atlas.util.geo import bbox_around
from atlas.util.timeutil import from_epoch_ms, iso_z, utcnow

log = logging.getLogger("atlas.demo")

FDSN = "https://earthquake.usgs.gov/fdsnws/event/1/query"
OUT = REPO_ROOT / "apps" / "web" / "public" / "demo" / "historical-earthquakes.json"


@dataclass(frozen=True)
class DemoEvent:
    usgs_id: str
    name: str


CURATED: tuple[DemoEvent, ...] = (
    DemoEvent("official20110311054624120_30", "2011 Tōhoku, Japan"),
    DemoEvent("us6000jllz", "2023 Kahramanmaraş sequence, Türkiye–Syria"),
    DemoEvent("official20041226005853450_30", "2004 Sumatra–Andaman"),
    DemoEvent("official20100227063411530_30", "2010 Maule, Chile"),
    DemoEvent("us20002926", "2015 Gorkha, Nepal"),
    DemoEvent("usp000h60h", "2010 Léogâne, Haiti"),
    DemoEvent("us7000kufc", "2023 Al Haouz, Morocco"),
    DemoEvent("us6000m0xl", "2024 Noto Peninsula, Japan"),
)


async def _fetch(http: HttpClient, params: dict[str, str | int | float]) -> dict[str, Any]:
    res = await http.get(FDSN, params=params, ttl=timedelta(days=30), source_id="usgs", max_bytes=32 * 1024 * 1024)
    data: dict[str, Any] = orjson.loads(res.content)
    return data


async def build_demo(out: Path = OUT) -> int:
    settings = get_settings()
    registry = load_registry(settings.registry_path)
    http = HttpClient(HttpCache(settings.cache_dir / "http"), UrlPolicy(registry.all_hosts()))
    events: list[dict[str, Any]] = []
    try:
        for ev in CURATED:
            main = await _fetch(http, {"eventid": ev.usgs_id, "format": "geojson"})
            p = main["properties"]
            lon, lat, depth = main["geometry"]["coordinates"][:3]
            t0 = from_epoch_ms(p["time"])
            assert t0 is not None
            w, s, e, n = bbox_around(lat, lon, 300)
            seq = await _fetch(
                http,
                {
                    "format": "geojson", "starttime": (t0 - timedelta(hours=2)).isoformat(timespec="seconds"),
                    "endtime": (t0 + timedelta(days=7)).isoformat(timespec="seconds"), "minmagnitude": 4.0,
                    "minlatitude": s, "maxlatitude": n, "minlongitude": w, "maxlongitude": e,
                    "orderby": "time-asc", "limit": 3000,
                },
            )  # fmt: skip
            cols: dict[str, list[Any]] = {"t": [], "lat": [], "lon": [], "depth": [], "mag": []}
            for f in seq.get("features", []):
                c = f["geometry"]["coordinates"]
                cols["t"].append(f["properties"]["time"])
                cols["lat"].append(round(c[1], 4))
                cols["lon"].append(round(c[0], 4))
                cols["depth"].append(round(c[2], 1) if c[2] is not None else None)
                cols["mag"].append(f["properties"]["mag"])
            events.append(
                {
                    "id": ev.usgs_id,
                    "name": ev.name,
                    "title": p["title"],
                    "time": iso_z(t0),
                    "lat": lat,
                    "lon": lon,
                    "depth_km": depth,
                    "magnitude": p["mag"],
                    "mag_type": p.get("magType"),
                    "pager_alert": p.get("alert"),
                    "tsunami_flag": bool(p.get("tsunami")),
                    "felt": p.get("felt"),
                    "mmi": p.get("mmi"),
                    "url": p.get("url"),
                    "sequence": {"count": len(cols["t"]), "window": "-2 h … +7 days, ≤300 km, M ≥ 4.0", "columns": cols},
                }
            )
            log.info("demo: %s — %d events in sequence", ev.name, len(cols["t"]))
    finally:
        await http.aclose()
    payload = {
        "generated_at": iso_z(utcnow()),
        "source": "USGS ComCat via the FDSN event web service",
        "attribution": "Earthquake data: U.S. Geological Survey (USGS)",
        "license": "Public domain (U.S. Government work)",
        "note": "Historical events for offline demonstrations. Timestamps are historical; this is not live data.",
        "events": events,
    }
    size = await asyncio.to_thread(_write_json, out, payload)
    print(f"wrote {out} ({size / 1024:.0f} KB, {len(events)} events)")
    return 0


def _write_json(out: Path, payload: dict[str, Any]) -> int:
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, separators=(",", ":")), "utf-8")
    return out.stat().st_size
