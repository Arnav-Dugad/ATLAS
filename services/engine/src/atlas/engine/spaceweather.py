"""Space weather context from NOAA SWPC's public "NOAA scales" product.

Current R (radio blackout), S (solar radiation storm) and G (geomagnetic storm) levels, plus
SWPC's own three-day outlook (G level and R/S probabilities). Shown as attributed agency
information on the overview — not as incidents: a geomagnetic storm has no single location.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any

import orjson

from atlas.http.client import HttpClient
from atlas.util.timeutil import iso_z, utcnow

URL = "https://services.swpc.noaa.gov/products/noaa-scales.json"
ATTRIBUTION = "Space weather: NOAA Space Weather Prediction Center (SWPC)"

SCALE_TEXT = {
    "R": "Radio blackouts (solar flares)",
    "S": "Solar radiation storms",
    "G": "Geomagnetic storms",
}


def _int(v: object) -> int | None:
    try:
        return int(str(v))
    except (TypeError, ValueError):
        return None


def parse(payload: dict[str, Any]) -> dict[str, Any]:
    now = payload.get("0") or {}
    days = []
    for key in ("1", "2", "3"):
        d = payload.get(key)
        if not isinstance(d, dict):
            continue
        r, s_, g = d.get("R") or {}, d.get("S") or {}, d.get("G") or {}
        days.append(
            {
                "date": d.get("DateStamp"),
                "g_scale": _int(g.get("Scale")),
                "r1_r2_probability": _int(r.get("MinorProb")),
                "r3_plus_probability": _int(r.get("MajorProb")),
                "s1_plus_probability": _int(s_.get("Prob")),
            }
        )
    current = {}
    for k in ("R", "S", "G"):
        block = now.get(k) or {}
        current[k] = {"scale": _int(block.get("Scale")), "text": block.get("Text"), "meaning": SCALE_TEXT[k]}
    return {
        "status": "ok",
        "source": "swpc",
        "attribution": ATTRIBUTION,
        "observed_at": f"{now.get('DateStamp')}T{now.get('TimeStamp')}Z" if now.get("DateStamp") else None,
        "current": current,
        "outlook": days,
        "note": "Current levels are observed by NOAA SWPC; the outlook is SWPC's forecast, quoted as issued.",
        "retrieved_at": iso_z(utcnow()),
    }


async def fetch(http: HttpClient) -> dict[str, Any]:
    res = await http.get(URL, ttl=timedelta(minutes=10), source_id="swpc", max_bytes=256 * 1024, timeout_s=20)
    data = orjson.loads(res.content)
    if not isinstance(data, dict):
        raise ValueError("unexpected SWPC payload")
    return parse(data)
