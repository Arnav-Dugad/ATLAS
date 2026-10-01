from __future__ import annotations

import asyncio
from typing import Any

import pytest

from atlas.engine import hapi


def test_country_context_picks_latest_period_and_key_figures(monkeypatch: pytest.MonkeyPatch) -> None:
    rows: dict[str, list[dict[str, Any]]] = {
        "/coordination-context/national-risk": [
            {"risk_class": "High", "overall_risk": 6.1, "global_rank": 20, "reference_period_end": "2025-12-31"},
            {"risk_class": "Medium", "overall_risk": 4.0, "global_rank": 60, "reference_period_end": "2024-12-31"},
        ],
        "/affected-people/humanitarian-needs": [
            {"population_status": "INN", "sector_code": "Intersectoral", "population": 2_400_000, "reference_period_end": "2026-12-31"},
            {"population_status": "TGT", "sector_code": "Intersectoral", "population": 1_000_000, "reference_period_end": "2026-12-31"},
        ],
        "/food-security-nutrition-poverty/food-security": [
            {"ipc_type": "current", "ipc_phase": "3+", "population_in_phase": 900_000, "population_fraction_in_phase": 0.21, "reference_period_end": "2026-08-31"},
        ],
        "/coordination-context/funding": [{"appeal_name": "HRP 2026", "requirements_usd": 1e8, "funding_pct": 23.5, "reference_period_start": "2026-01-01"}],
    }  # fmt: skip

    async def fake_get(_http: Any, path: str, _ident: str, **_p: Any) -> list[dict[str, Any]]:
        return rows[path]

    monkeypatch.setattr(hapi, "_get", fake_get)
    out = asyncio.run(hapi.country(None, "x", "SDN"))  # type: ignore[arg-type]
    assert out["risk"]["risk_class"] == "High"
    assert out["people_in_need"]["population"] == 2_400_000
    assert out["ipc3_plus"]["population"] == 900_000
    assert out["funding"]["funding_pct"] == 23.5
    with pytest.raises(ValueError):
        asyncio.run(hapi.country(None, "x", "sd; drop"))  # type: ignore[arg-type]
