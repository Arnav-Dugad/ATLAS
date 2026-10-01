from __future__ import annotations

from datetime import datetime

from atlas.engine.cems import match, parse

RAW = [
    {"code": "EMSR932", "countries": ["Spain"], "eventTime": "2026-09-15T13:00:00", "name": "Wildfire in Huelva Province, Spain",
     "centroid": "POINT (-7.213497 37.789542)", "activationTime": "2026-09-15T16:58:00", "category": "Wildfire", "closed": True, "n_products": 1},
    {"code": "EMSR930", "countries": ["Italy"], "eventTime": "2026-09-02T13:00:00", "name": "Storm in Basilicata",
     "centroid": "POINT (16.69 40.23)", "activationTime": "2026-09-07T14:44:00", "category": "Storm"},
    {"code": "javascript:alert(1)", "centroid": "POINT (0 0)"},
]  # fmt: skip


def test_parse_validates_codes_and_points() -> None:
    acts = parse(RAW)
    assert [a["code"] for a in acts] == ["EMSR932", "EMSR930"]
    assert acts[0]["hazard"] == "wildfire" and acts[0]["url"].endswith("/EMSR932/")


def test_match_needs_same_hazard_place_and_time() -> None:
    acts = parse(RAW)
    hit = match(acts, "wildfire", 37.7, -7.3, datetime(2026, 9, 14))
    assert [a["code"] for a in hit] == ["EMSR932"] and hit[0]["distance_km"] < 20
    assert match(acts, "flood", 37.7, -7.3, datetime(2026, 9, 14)) == []
    assert match(acts, "wildfire", 37.7, -7.3, datetime(2026, 6, 1)) == []
