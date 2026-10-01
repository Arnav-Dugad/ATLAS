"""Space weather context from NOAA SWPC's public "NOAA scales" product.

Current R (radio blackout), S (solar radiation storm) and G (geomagnetic storm) levels, plus
SWPC's own three-day outlook (G level and R/S probabilities). Shown as attributed agency
information on the overview — not as incidents: a geomagnetic storm has no single location.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any

import orjson

from atlas.http.client import FetchError, HttpClient
from atlas.util.timeutil import iso_z, utcnow

URL = "https://services.swpc.noaa.gov/products/noaa-scales.json"
FLARES = "https://services.swpc.noaa.gov/json/goes/primary/xray-flares-7-day.json"
CLASS_ORDER = "ABCMX"
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


def flare_rank(cls: str) -> float:
    """'M2.4' → 3.24, so classes compare by letter first, then by number."""
    try:
        return CLASS_ORDER.index(cls[0].upper()) + float(cls[1:]) / 10
    except (IndexError, ValueError):
        return -1.0


def parse_flares(items: list[dict[str, Any]]) -> dict[str, Any]:
    """Strongest flare of the last 7 days and the count of M and X class flares (GOES X-ray)."""
    flares = [f for f in items if isinstance(f, dict) and isinstance(f.get("max_class"), str)]
    strongest = max(flares, key=lambda f: flare_rank(f["max_class"]), default=None)
    big = [f for f in flares if f["max_class"][:1].upper() in "MX"]
    return {
        "count": len(flares),
        "m_class": sum(1 for f in big if f["max_class"][:1].upper() == "M"),
        "x_class": sum(1 for f in big if f["max_class"][:1].upper() == "X"),
        "strongest": {"class": strongest["max_class"], "peak": strongest.get("max_time")} if strongest else None,
        "recent_major": [
            {"class": f["max_class"], "peak": f.get("max_time")}
            for f in sorted(big, key=lambda f: f.get("max_time") or "", reverse=True)[:5]
        ],
        "note": "GOES X-ray flares, last 7 days. M and X class flares can cause radio blackouts on the sunlit side of Earth.",
    }


async def fetch(http: HttpClient) -> dict[str, Any]:
    res = await http.get(URL, ttl=timedelta(minutes=10), source_id="swpc", max_bytes=256 * 1024, timeout_s=20)
    data = orjson.loads(res.content)
    if not isinstance(data, dict):
        raise ValueError("unexpected SWPC payload")
    out = parse(data)
    try:
        fl = await http.get(FLARES, ttl=timedelta(minutes=10), source_id="swpc", max_bytes=1024 * 1024, timeout_s=20)
        items = orjson.loads(fl.content)
        out["flares"] = parse_flares(items if isinstance(items, list) else [])
    except (FetchError, orjson.JSONDecodeError) as exc:
        out["flares"] = None
        out["flares_error"] = str(exc)[:200]
    return out
