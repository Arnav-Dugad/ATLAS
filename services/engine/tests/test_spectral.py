"""Sentinel-2 change analysis: pure parts tested with synthetic arrays (no network)."""

from __future__ import annotations

import struct
import zlib
from datetime import UTC, datetime
from pathlib import Path

import numpy as np
import pytest

from atlas.engine.spectral import (
    INDICES,
    Grid,
    SpectralService,
    analysis_window,
    classify,
    group_passes,
    headline,
    png_rgba,
    prefer_clear,
)
from atlas.http.cache import HttpCache
from atlas.http.client import HttpClient
from atlas.http.security import UrlPolicy
from atlas.models import Hazard

COG = "https://sentinel-cogs.s3.us-west-2.amazonaws.com/sentinel-s2-l2a-cogs/10/S/GG/2026/9/{id}/{band}.tif"


def item(item_id: str, day: str, tile: str, platform: str = "sentinel-2b", cloud: float = 1.0, host_ok: bool = True) -> dict:
    href = COG if host_ok else "https://evil.example.com/{id}/{band}.tif"
    bands = ["nir", "swir22", "green", "swir16", "red", "scl", "visual"]
    return {
        "id": item_id,
        "properties": {
            "datetime": f"{day}T18:54:04Z",
            "platform": platform,
            "grid:code": f"MGRS-{tile}",
            "eo:cloud_cover": cloud,
        },
        "assets": {b: {"href": href.format(id=item_id, band=b.upper())} for b in bands},
    }


class TestWindow:
    def test_point_window_is_hazard_sized_square(self) -> None:
        w, s, e, n = analysis_window("wildfire", 0.0, 10.0, None)
        assert (n - s) * 110.574 == pytest.approx(12, abs=0.1)  # 2 × 6 km
        assert (e - w) * 111.320 == pytest.approx(12, abs=0.1)

    def test_footprint_gets_a_margin_and_a_cap(self) -> None:
        w, s, e, n = analysis_window("wildfire", 37.6, -119.6, [-119.62, 37.58, -119.58, 37.62])
        assert w < -119.62 and e > -119.58 and s < 37.58 and n > 37.62
        huge = analysis_window("flood", 10.0, 10.0, [8.0, 8.0, 12.0, 12.0])
        assert (huge[3] - huge[1]) * 110.574 <= 40.5  # capped at 40 km

    def test_grid_stays_small_and_never_finer_than_10_m(self) -> None:
        g = Grid.for_bbox(analysis_window("flood", 45.0, 10.0, None))
        assert max(g.width, g.height) <= 768 and g.res_m >= 10
        tiny = Grid.for_bbox((10.0, 45.0, 10.01, 45.01))
        assert tiny.res_m == 10.0
        assert g.row_area_km2().shape == (g.height,)


class TestCatalogue:
    def test_groups_tiles_of_one_pass_and_keeps_latest_processing(self) -> None:
        passes = group_passes(
            [
                item("S2B_10SGG_20260912_0_L2A", "2026-09-12", "10SGG"),
                item("S2B_11SKB_20260912_0_L2A", "2026-09-12", "11SKB"),
                item("S2B_11SKB_20260912_1_L2A", "2026-09-12", "11SKB"),  # reprocessed
                item("S2C_10SGG_20260917_0_L2A", "2026-09-17", "10SGG", platform="sentinel-2c"),
            ],
            ("nir", "swir22"),
        )
        assert [p.key for p in passes] == ["sentinel-2c:2026-09-17", "sentinel-2b:2026-09-12"]
        ids = sorted(it["id"] for it in passes[1].items)
        assert ids == ["S2B_10SGG_20260912_0_L2A", "S2B_11SKB_20260912_1_L2A"]

    def test_rejects_assets_outside_the_cog_bucket(self) -> None:
        assert group_passes([item("X", "2026-09-12", "10SGG", host_ok=False)], ("nir", "swir22")) == []

    def test_clear_scenes_are_tried_first_without_losing_order(self) -> None:
        passes = group_passes(
            [
                item("A", "2026-09-27", "10SGG", cloud=60),
                item("B", "2026-09-22", "10SGG", cloud=2),
                item("C", "2026-09-17", "10SGG", cloud=10),
            ],
            ("nir", "swir22"),
        )
        assert [p.items[0]["id"] for p in prefer_clear(passes)] == ["B", "C", "A"]


def _area_row(h: int) -> np.ndarray:
    return np.full(h, 0.01)  # 0.01 km² per pixel


class TestClassify:
    def test_dnbr_classes_follow_usgs_ranges(self) -> None:
        pre = np.full((2, 4), 0.6, np.float32)
        post = np.array([[0.6, 0.45, 0.25, -0.2], [0.75, 0.9, 0.6, 0.6]], np.float32)  # dNBR 0, .15, .35, .8 / -.15, -.3, 0, 0
        valid = np.ones_like(pre, bool)
        valid[1, 3] = False  # masked by clouds
        classes, rgba = classify(INDICES["nbr"], pre, post, valid, _area_row(2))
        area = {c["key"]: c["area_km2"] for c in classes}
        assert area["low"] == pytest.approx(0.01)
        assert area["moderate_low"] == pytest.approx(0.01)
        assert area["high"] == pytest.approx(0.01)
        assert area["regrowth_low"] == pytest.approx(0.01)
        assert area["regrowth_high"] == pytest.approx(0.01)
        assert area["unburned"] == pytest.approx(0.02)
        assert rgba[1, 3, 3] == 0  # masked pixel stays transparent
        h = headline(INDICES["nbr"], classes)
        assert h["value"] == pytest.approx(0.03) and h["unit"] == "km²"

    def test_mndwi_new_water(self) -> None:
        pre = np.array([[-0.3, 0.2, 0.3, -0.1]], np.float32)
        post = np.array([[0.4, 0.3, -0.2, -0.2]], np.float32)
        classes, _ = classify(INDICES["mndwi"], pre, post, np.ones((1, 4), bool), _area_row(1))
        area = {c["key"]: c["area_km2"] for c in classes}
        assert area == {"new_water": 0.01, "persistent_water": 0.01, "receded": 0.01, "dry": 0.01}
        assert headline(INDICES["mndwi"], classes)["value"] == pytest.approx(0.01)

    def test_ndvi_threshold_is_symmetric_heuristic(self) -> None:
        pre = np.array([[0.8, 0.5, 0.3]], np.float32)
        post = np.array([[0.5, 0.45, 0.6]], np.float32)
        classes, _ = classify(INDICES["ndvi"], pre, post, np.ones((1, 3), bool), _area_row(1))
        area = {c["key"]: c["area_km2"] for c in classes}
        assert area == {"loss": 0.01, "gain": 0.01, "stable": 0.01}


def test_png_encoder_writes_a_valid_rgba_png() -> None:
    img = np.zeros((3, 5, 4), np.uint8)
    img[..., 0] = 255
    data = png_rgba(img)
    assert data[:8] == b"\x89PNG\r\n\x1a\n"
    w, h, depth, colour = struct.unpack(">IIBB", data[16:26])
    assert (w, h, depth, colour) == (5, 3, 8, 6)
    idat_len = struct.unpack(">I", data[33:37])[0]
    raw = zlib.decompress(data[41 : 41 + idat_len])
    assert len(raw) == 3 * (1 + 5 * 4)


class TestService:
    @pytest.fixture
    def svc(self, tmp_path: Path) -> SpectralService:
        http = HttpClient(HttpCache(tmp_path / "http"), UrlPolicy(["earth-search.aws.element84.com"]))
        return SpectralService(http, tmp_path, offline=True)

    def test_file_lookup_rejects_traversal_and_unknown_names(self, svc: SpectralService) -> None:
        assert svc.file("ATL-WF-2026-ABCDEFGH", "nbr", "../../secrets") is None
        assert svc.file("../../etc", "nbr", "change.png") is None
        assert svc.file("ATL-WF-2026-ABCDEFGH", "evil", "change.png") is None
        assert svc.file("ATL-WF-2026-ABCDEFGH", "nbr", "change.png") is None  # valid but absent

    async def test_offline_mode_is_explicitly_unavailable(self, svc: SpectralService) -> None:
        out = await svc.analyse("ATL-WF-2026-ABCDEFGH", Hazard.WILDFIRE, 37.6, -119.6, None, datetime(2026, 9, 15, tzinfo=UTC))
        assert out["status"] == "unavailable" and out["provenance"] == "unavailable"
        assert "Offline" in out["reason"]
