from __future__ import annotations

from datetime import datetime

import h3.api.basic_int as h3i
import numpy as np

from atlas.engine.growth import bearing, compute


def test_bearing_cardinal_directions() -> None:
    assert round(bearing(0, 0, 1, 0)) == 0
    assert round(bearing(0, 0, 0, 1)) == 90
    assert round(bearing(0, 0, -1, 0)) == 180


def test_fire_spreading_east_is_reported_east() -> None:
    now = datetime(2026, 10, 1, 12)
    now_s = (now - datetime(1970, 1, 1)).total_seconds()
    t, lat, lon = [], [], []
    # an older burn in the west, a fresh front 5 km east in the last 6 hours
    for i in range(30):
        t.append(now_s - 30 * 3600)
        lat.append(-15.0 + (i % 5) * 0.004)
        lon.append(30.0 + (i // 5) * 0.004)
    for i in range(30):
        t.append(now_s - 3 * 3600)
        lat.append(-15.0 + (i % 5) * 0.004)
        lon.append(30.05 + (i // 5) * 0.004)
    r9 = np.array([h3i.latlng_to_cell(a, b, 9) for a, b in zip(lat, lon, strict=True)], dtype=np.uint64)
    out = compute(np.array(t, dtype=float), np.array(lat), np.array(lon), r9, now)
    assert out["spread"]["compass"] == "E"
    assert out["spread"]["meaningful"] is True
    assert 4 < out["spread"]["shift_km"] < 7
    assert out["new_last_12h_km2"] > 0
    assert out["series"][-1]["cumulative_km2"] == out["footprint_km2"]
    assert sum(b["detections"] for b in out["series"]) == 60
