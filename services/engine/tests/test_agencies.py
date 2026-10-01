from __future__ import annotations

from datetime import datetime

from atlas.engine.agencies import match, parse_jma, parse_jma_cod, parse_ncs
from atlas.http.client import tls_context


def test_jma_coordinates_and_events() -> None:
    assert parse_jma_cod("+35.8+140.7-40000/") == (35.8, 140.7, 40.0)
    assert parse_jma_cod("-12.5+166.2/") == (-12.5, 166.2, None)
    assert parse_jma_cod("garbage") is None
    events = parse_jma(
        [
            {
                "eid": "1",
                "at": "2026-10-01T21:27:00+09:00",
                "cod": "+35.8+140.7-50000/",
                "mag": "5.1",
                "maxi": "",
                "en_anm": "Chiba",
            },
            {"eid": "1", "at": "2026-10-01T21:27:00+09:00", "cod": "", "mag": "", "maxi": "5-"},
        ]
    )
    assert len(events) == 1
    ev = events[0]
    assert ev["time"] == datetime(2026, 10, 1, 12, 27) and ev["magnitude"] == 5.1 and ev["max_intensity"] == "5 lower"


def test_ncs_page_json_is_converted_from_ist() -> None:
    page = (
        "<a data-json='{&quot;event_id&quot;:&quot;X&quot;,&quot;event_name&quot;:&quot;M: 3.7 - Shi Yomi&quot;,"
        "&quot;origin_time&quot;:&quot;2026-10-01 13:46:09 IST&quot;,&quot;lat_long&quot;:&quot;28.779, 94.261&quot;,"
        "&quot;magnitude_depth&quot;:&quot;M: 3.7 , D: 10km&quot;,&quot;event_type&quot;:&quot;Reviewed&quot;}'>"
    )
    ev = parse_ncs(page)
    assert len(ev) == 1
    assert ev[0]["time"] == datetime(2026, 10, 1, 8, 16, 9)
    assert ev[0]["magnitude"] == 3.7 and ev[0]["depth_km"] == 10.0


def test_match_picks_the_closest_event_within_limits() -> None:
    cands = [
        {"id": "far", "time": datetime(2026, 1, 1, 0, 0, 30), "lat": 10.0, "lon": 12.0},
        {"id": "near", "time": datetime(2026, 1, 1, 0, 0, 40), "lat": 10.05, "lon": 10.0},
        {"id": "late", "time": datetime(2026, 1, 1, 0, 30), "lat": 10.0, "lon": 10.0},
    ]
    hit = match(cands, datetime(2026, 1, 1), 10.0, 10.0, max_s=120, max_km=150)
    assert hit is not None and hit["id"] == "near" and hit["delta_s"] == 40
    assert match(cands, datetime(2026, 1, 2), 10.0, 10.0, max_s=120, max_km=150) is None


def test_tls_context_keeps_verification_on() -> None:
    import ssl

    ctx = tls_context()
    assert ctx.verify_mode == ssl.CERT_REQUIRED and ctx.check_hostname
    assert any("GlobalSign RSA OV SSL CA 2018" in str(c.get("subject")) for c in ctx.get_ca_certs())
