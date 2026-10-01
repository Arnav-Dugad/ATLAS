from __future__ import annotations

import asyncio
import json
from contextlib import contextmanager
from pathlib import Path
from typing import Any

import pytest

from atlas.engine import gallery


class FakeSpectral:
    def __init__(self, root: Path, cached: set[str]) -> None:
        self.root = root
        self._cached = cached
        self.calls: list[str] = []

    def cached(self, iid: str, index: str) -> dict[str, Any] | None:
        return {"status": "ok"} if iid in self._cached else None

    async def analyse(self, iid: str, *_a: Any) -> dict[str, Any]:
        self.calls.append(iid)
        return {"status": "ok"}


def test_refresh_skips_fresh_results_and_stays_polite(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    fires = [(f"ATL-WF-2026-0000000{i}", 1.0, 2.0, None, None) for i in range(8)]
    monkeypatch.setattr(gallery, "candidates", lambda _db: fires)
    sp = FakeSpectral(tmp_path, cached={fires[0][0], fires[2][0]})
    assert asyncio.run(gallery.refresh(sp, None, per_run=3)) == 3  # type: ignore[arg-type]
    assert sp.calls == [fires[1][0], fires[3][0], fires[4][0]]


class FakeDb:
    def __init__(self, rows: list[tuple[Any, ...]]) -> None:
        self.rows = rows

    @contextmanager
    def read(self):  # type: ignore[no-untyped-def]
        rows = self.rows

        class Cur:
            def execute(self, *_a: Any) -> Any:
                class R:
                    def fetchall(self) -> list[tuple[Any, ...]]:
                        return rows

                return R()

        yield Cur()


def test_listing_keeps_existing_incidents_largest_first(tmp_path: Path) -> None:
    def write(iid: str, value: float, status: str = "ok") -> None:
        d = tmp_path / iid / "nbr"
        d.mkdir(parents=True)
        (d / "result.json").write_text(
            json.dumps({"status": status, "headline": {"value": value}, "window": {"bbox": [0, 0, 1, 1]}})
        )

    write("ATL-WF-2026-AAAAAAAA", 3.0)
    write("ATL-WF-2026-BBBBBBBB", 40.0)
    write("ATL-WF-2026-GONEGONE", 99.0)  # incident no longer exists
    write("ATL-WF-2026-CCCCCCCC", 10.0, status="unavailable")
    db = FakeDb(
        [
            ("ATL-WF-2026-AAAAAAAA", "Fire A", "active", 3),
            ("ATL-WF-2026-BBBBBBBB", "Fire B", "active", 4),
            ("ATL-WF-2026-CCCCCCCC", "Fire C", "active", 2),
        ]
    )
    items = gallery.listing(FakeSpectral(tmp_path, set()), db)  # type: ignore[arg-type]
    assert [i["title"] for i in items] == ["Fire B", "Fire A"]
