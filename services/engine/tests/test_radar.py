from __future__ import annotations

from datetime import datetime

import numpy as np

from atlas.engine import radar, spectral


def _item(i: str, when: str, orbit: int, state: str = "descending", host: str = radar.BLOB_HOST) -> dict:
    return {
        "id": i,
        "properties": {"datetime": when, "platform": "sentinel-1d", "sat:relative_orbit": orbit, "sat:orbit_state": state},
        "assets": {"vv": {"href": f"https://{host}/x/{i}/iw-vv.rtc.tiff"}},
    }


def test_box_mean_smooths_and_ignores_nan() -> None:
    a = np.ones((6, 6))
    a[2, 2] = 26.0
    a[0, 0] = np.nan
    out = radar.box_mean(a, 5)
    assert np.isnan(out[0, 0])
    assert out[2, 2] == np.float64((26 + 23) / 24)  # 24 valid neighbours incl. itself in the 5x5
    assert abs(out[5, 5] - 1.0) < 1e-12


def test_pairs_after_with_same_orbit_before() -> None:
    items = [
        _item("a", "2026-09-01T23:55:00Z", 150),
        _item("b", "2026-09-07T12:03:00Z", 114, "ascending"),
        _item("c", "2026-09-13T23:55:00Z", 150),
        _item("d", "2026-09-19T12:03:00Z", 114, "ascending"),
        _item("e", "2026-09-25T23:55:00Z", 150),
        _item("evil", "2026-09-26T23:55:00Z", 150, host="evil.example"),
    ]
    passes = radar.group_passes(items)
    assert [p.items[0]["id"] for p in passes] == ["a", "b", "c", "d", "e"]  # foreign host dropped
    pair = radar.choose_pair(passes, datetime(2026, 9, 15))
    assert pair is not None
    before, after = pair
    assert after.items[0]["id"] == "e" and before.items[0]["id"] == "c"  # same orbit 150, latest before onset


def test_dark_backscatter_is_classed_as_new_water() -> None:
    spec = spectral.INDICES["sar"]
    pre_db = np.full((4, 4), -8.0)
    post_db = pre_db.copy()
    post_db[:2, :] = -22.0  # newly dark (flooded)
    valid = np.ones((4, 4), bool)
    classes, rgba = spectral.classify(spec, radar.WATER_DB - pre_db, radar.WATER_DB - post_db, valid, np.ones(4))
    by = {c["key"]: c["area_km2"] for c in classes}
    assert by["new_water"] == 8.0 and by["persistent_water"] == 0.0
    assert spectral.headline(spec, classes)["value"] == 8.0
    assert rgba[0, 0, 3] > 0 and rgba[3, 3, 3] == 0


def test_land_mask_excludes_sea(tmp_path) -> None:
    import json

    path = tmp_path / "land.geojson"
    land = {"type": "Polygon", "coordinates": [[[0, 0], [1, 0], [1, 2], [0, 2], [0, 0]]]}  # west half of the window
    path.write_text(
        json.dumps({"type": "FeatureCollection", "features": [{"type": "Feature", "properties": {}, "geometry": land}]})
    )
    mask = radar.Land(path).mask((0.0, 0.0, 2.0, 2.0), 4, 4)
    assert mask[:, :2].all() and not mask[:, 2:].any()
