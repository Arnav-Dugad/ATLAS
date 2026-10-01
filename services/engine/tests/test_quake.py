from __future__ import annotations

import asyncio
import math
from typing import Any

import pytest

from atlas.engine import quake


def test_poisson_tail_matches_closed_forms() -> None:
    assert quake.poisson_tail(0, 3.0) == 1.0
    assert quake.poisson_tail(1, 2.0) == pytest.approx(1 - math.exp(-2.0))
    # far tail stays accurate instead of collapsing to 0 through 1 - cdf
    assert 0 < quake.poisson_tail(40, 1.0) < 1e-40
    assert quake.poisson_tail(5, 0.0) == 0.0


def test_event_ids_and_product_hosts_are_validated() -> None:
    assert quake.valid_event_id("us7000ti1p")
    assert not quake.valid_event_id("../../etc")
    assert quake._usgs_url("https://earthquake.usgs.gov/product/x.json")
    assert quake._usgs_url("http://earthquake.usgs.gov/product/x.json") is None
    assert quake._usgs_url("https://evil.example/earthquake.usgs.gov/x.json") is None


DETAIL: dict[str, Any] = {
    "properties": {
        "url": "https://earthquake.usgs.gov/earthquakes/eventpage/us1",
        "products": {
            "shakemap": [
                {
                    "updateTime": 1790282713802,
                    "properties": {"version": "10", "maxmmi": "6.2", "map-status": "automatic"},
                    "contents": {"download/cont_mmi.json": {"url": "https://earthquake.usgs.gov/p/cont_mmi.json"}},
                }
            ],
            "losspager": [
                {
                    "updateTime": 1790282867992,
                    "properties": {"alertlevel": "yellow", "review-status": "reviewed"},
                    "contents": {"json/exposures.json": {"url": "https://earthquake.usgs.gov/p/exposures.json"}},
                }
            ],
            "oaf": [{"contents": {"forecast.json": {"url": "https://evil.example/forecast.json"}}}],
            "origin": [{"properties": {"horizontal-error": "5.72", "num-stations-used": "150", "review-status": "reviewed"}}],
        },
    }
}
FILES: dict[str, Any] = {
    "https://earthquake.usgs.gov/p/cont_mmi.json": {
        "features": [
            {
                "properties": {"value": 5.0, "color": "#7aff93"},
                "geometry": {"type": "LineString", "coordinates": [[1.123456, 2.123456], [1.2, 2.2]]},
            },
            {"properties": {"value": 6.0}, "geometry": {"type": "Point", "coordinates": [1, 2]}},
        ]
    },
    "https://earthquake.usgs.gov/p/exposures.json": {
        "population_exposure": {"mmi": [4, 5, 6], "aggregated_exposure": [1000, 200, 30]}
    },
}


def test_products_quote_usgs_and_ignore_foreign_urls(monkeypatch: pytest.MonkeyPatch) -> None:
    fetched: list[str] = []

    async def fake_json(_http: Any, url: str, _ttl: Any, params: Any = None) -> Any:
        fetched.append(url)
        return DETAIL if url == quake.FDSN else FILES[url]

    monkeypatch.setattr(quake, "_json", fake_json)
    out = asyncio.run(quake.products(None, "us1"))  # type: ignore[arg-type]
    assert out["shakemap"]["max_mmi"] == 6.2
    contours = out["shakemap"]["contours"]["features"]
    assert len(contours) == 1 and contours[0]["geometry"]["coordinates"][0] == [1.1235, 2.1235]
    assert out["pager"]["alert_level"] == "yellow"
    assert out["pager"]["exposure"][2] == {"mmi": 6, "population": 30}
    assert out["aftershocks"] is None  # forecast hosted off-USGS is never fetched
    assert not any("evil" in u for u in fetched)
    assert out["location"]["horizontal_error_km"] == 5.72 and out["location"]["stations"] == 150


def test_activity_compares_week_with_baseline(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_json(_http: Any, url: str, _ttl: Any, params: Any = None) -> Any:
        start = params["starttime"]
        return {"count": 30 if start > "2026" else 521}  # ~1 a week usually, 30 this week

    monkeypatch.setattr(quake, "_json", fake_json)
    from datetime import datetime

    out = asyncio.run(quake.activity(None, 10.0, 20.0, now=datetime(2026, 10, 1)))  # type: ignore[arg-type]
    assert out["week_count"] == 30
    assert out["verdict"] == "far above usual"
    assert out["p_value"] < 1e-20
    assert "not a forecast" in out["method"]
