from __future__ import annotations

import asyncio
from typing import Any

import orjson
import pytest

from atlas.engine import worldpop


def test_ring_is_a_closed_polygon_of_the_right_size() -> None:
    fc = orjson.loads(worldpop.ring_geojson(0.0, 0.0, 111.195))
    ring = fc["features"][0]["geometry"]["coordinates"][0]
    assert ring[0] == ring[-1]
    assert max(abs(p[1]) for p in ring) == pytest.approx(1.0, abs=0.01)  # 111.2 km ≈ 1° of latitude


def test_compare_skips_large_rings_and_reports_ratios(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_total(_http: Any, geojson: str) -> float:
        return 1500.0

    monkeypatch.setattr(worldpop, "total", fake_total)
    out = asyncio.run(worldpop.compare(None, 10.0, 20.0, [10, 50, 250], [1000.0, 3000.0, 9000.0]))  # type: ignore[arg-type]
    assert [r["radius_km"] for r in out["rows"]] == [10, 50]
    assert out["rows"][0]["ratio"] == 1.5 and out["rows"][1]["ratio"] == 0.5
    assert out["skipped_km"] == [250]
