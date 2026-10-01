from __future__ import annotations

from atlas.engine.alerts import _alert, _link, parse_cap, parse_sachet_polygon

CAP = b"""<cap:alert xmlns:cap="urn:oasis:names:tc:emergency:cap:1.2">
<cap:identifier>IN-1_9</cap:identifier><cap:sender>Uttarakhand-SDMA</cap:sender>
<cap:info><cap:language>HI</cap:language><cap:event>X</cap:event><cap:severity>Moderate</cap:severity></cap:info>
<cap:info><cap:language>en-IN</cap:language><cap:event>Thunderstorm with Lightning</cap:event><cap:severity>Severe</cap:severity>
<cap:expires>2026-10-02T00:15:00+05:30</cap:expires><cap:headline>Thunderstorm likely</cap:headline>
<cap:parameter><cap:valueName>Polygon URL</cap:valueName><cap:value>https://sachet.ndma.gov.in/p?identifier=1</cap:value></cap:parameter>
<cap:area><cap:areaDesc>uttarkashi,tehri</cap:areaDesc></cap:area></cap:info></cap:alert>"""


def test_cap_prefers_english_and_finds_polygon_url() -> None:
    cap = parse_cap(CAP)
    assert cap is not None
    assert cap["event"] == "Thunderstorm with Lightning" and cap["severity"] == "Severe"
    assert cap["area"] == "uttarkashi,tehri"
    assert cap["polygon_url"] == "https://sachet.ndma.gov.in/p?identifier=1"


def test_sachet_polygon_is_lon_lat_and_closed() -> None:
    g = parse_sachet_polygon(b"<alert><polygon>29.7,79.9 29.8,79.7 30.0,79.6 29.9,80.0</polygon></alert>")
    assert g is not None and g["type"] == "Polygon"
    ring = g["coordinates"][0]
    assert ring[0] == [79.9, 29.7] and ring[0] == ring[-1]


def test_untrusted_fields_are_normalised() -> None:
    a = _alert("nws-alerts", severity="Catastrophic", headline="x")
    assert a["severity"] == "Unknown" and a["severity_rank"] == 0
    assert _link("https://sachet.ndma.gov.in/x", "sachet.ndma.gov.in")
    assert _link("javascript:alert(1)", "sachet.ndma.gov.in") is None
    assert _link("https://evil.example/x", "sachet.ndma.gov.in") is None
