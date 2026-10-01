from __future__ import annotations

from datetime import datetime

from atlas.engine.sealevel import parse_dart, parse_ioc, thin


def test_ioc_keeps_the_main_sensor() -> None:
    rows = [
        {"slevel": 1.0, "stime": "2026-09-30 10:00:00", "sensor": "rad"},
        {"slevel": 1.1, "stime": "2026-09-30 10:01:00", "sensor": "rad"},
        {"slevel": 9.9, "stime": "2026-09-30 10:00:00", "sensor": "prs"},
    ]
    pts = parse_ioc(rows)
    assert [v for _t, v in pts] == [1.0, 1.1]


def test_dart_text_is_parsed_and_sorted() -> None:
    text = "#YY  MM DD hh mm ss T   HEIGHT\n#yr  mo dy hr mn  s -        m\n2026 10 01 12 00 00 1 4717.371\n2026 10 01 11 45 00 1 4717.396\n"
    pts = parse_dart(text)
    assert pts[0] == (datetime(2026, 10, 1, 11, 45), 4717.396)


def test_thin_caps_the_number_of_points() -> None:
    pts = [(datetime(2026, 1, 1, 0, i % 60), float(i)) for i in range(1000)]
    assert len(thin(pts, 100)) == 100
