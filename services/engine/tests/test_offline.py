from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from atlas.offline import MAX_TILES, OfflineStore, estimate, lat2y, lon2x, tiles_for


def test_tile_indices_match_web_mercator() -> None:
    assert (lon2x(0.0, 2), lat2y(0.0, 2)) == (1, 1)
    assert (lon2x(-180.0, 4), lat2y(85.0, 4)) == (0, 0)
    assert lon2x(179.99, 4) == 3


def test_region_tiles_cover_every_set_up_to_its_own_max_zoom() -> None:
    tiles = tiles_for((77.0, 28.4, 77.4, 28.8), 10)
    sets = {t[0] for t in tiles}
    assert sets == {"s2", "bluemarble", "terrain"}
    assert max(t[1] for t in tiles if t[0] == "bluemarble") == 8
    assert max(t[1] for t in tiles if t[0] == "s2") == 10
    assert estimate((77.0, 28.4, 77.4, 28.8), 10)["tiles"] == len(tiles)


def test_create_validates_and_downloads_into_its_own_folder(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    async def run() -> None:
        store = OfflineStore(tmp_path, None)  # type: ignore[arg-type]

        async def fake_fetch(name: str, z: int, x: int, y: int) -> bytes:
            return b"tile"

        monkeypatch.setattr(store, "fetch", fake_fetch)
        with pytest.raises(ValueError):
            store.create("too big", (0.0, 0.0, 10.0, 10.0), 8)
        with pytest.raises(ValueError):
            store.create("too detailed", (70.0, 20.0, 76.0, 26.0), 14)  # far more than MAX_TILES
        reg = store.create("Delhi", (77.0, 28.5, 77.1, 28.6), 9)
        await asyncio.wait_for(store._tasks[reg.id], 30)
        assert store.list()[0]["status"] == "ready"
        assert store.list()[0]["tiles_done"] == reg.tiles_total
        x, y = lon2x(77.05, 2**9), lat2y(28.55, 2**9)
        assert store.find("s2", 9, x, y) is not None
        assert store.delete(reg.id) and store.find("s2", 9, x, y) is None
        assert not store.delete("../../etc")

    asyncio.run(run())
    assert MAX_TILES >= 1000


def test_manifest_survives_a_restart(tmp_path: Path) -> None:
    (tmp_path / "regions.json").write_text(
        '[{"id": "abcdefabcdef", "name": "x", "bbox": [0, 0, 1, 1], "max_zoom": 8, "tiles_total": 5, "status": "downloading"}]'
    )
    store = OfflineStore(tmp_path, None)  # type: ignore[arg-type]
    assert store.list()[0]["status"] == "error"  # an interrupted download is not shown as ready
