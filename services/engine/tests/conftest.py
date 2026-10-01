from __future__ import annotations

import json
from collections.abc import Iterator
from datetime import datetime
from pathlib import Path

import pytest

from atlas.engine.geocode import Geocoder
from atlas.engine.pipeline import IngestPipeline
from atlas.jobs.bus import EventBus
from atlas.registry import Registry, load_registry
from atlas.store.db import Database

FIXTURES = Path(__file__).parent / "fixtures"
REPO = Path(__file__).resolve().parents[3]


def fixture_bytes(name: str) -> bytes:
    return (FIXTURES / name).read_bytes()


@pytest.fixture
def registry() -> Registry:
    return load_registry(REPO / "data" / "registry" / "sources.json")


@pytest.fixture
def db(tmp_path: Path) -> Iterator[Database]:
    database = Database(tmp_path / "test.duckdb")
    database.migrate()
    yield database
    database.close()


@pytest.fixture
def tiny_geocoder(tmp_path: Path) -> Geocoder:
    """Two square 'countries' and a handful of places — enough to test geocoding logic
    without the 11 MB Natural Earth Core Pack."""
    countries = {
        "type": "FeatureCollection",
        "features": [
            {"type": "Feature", "properties": {"NAME": "Westland", "ISO_A3": "WST", "CONTINENT": "Test"},
             "geometry": {"type": "Polygon", "coordinates": [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]]}},
            {"type": "Feature", "properties": {"NAME": "Eastland", "ISO_A3": "EST", "CONTINENT": "Test"},
             "geometry": {"type": "Polygon", "coordinates": [[[10, 0], [20, 0], [20, 10], [10, 10], [10, 0]]]}},
        ],
    }  # fmt: skip
    places = {
        "type": "FeatureCollection",
        "features": [
            {"type": "Feature", "properties": {"name": "Alpha", "nameascii": "Alpha", "adm0name": "Westland", "adm0_a3": "WST", "pop_max": 2_000_000},
             "geometry": {"type": "Point", "coordinates": [5, 5]}},
            {"type": "Feature", "properties": {"name": "Beta", "nameascii": "Beta", "adm0name": "Westland", "adm0_a3": "WST", "pop_max": 5_000},
             "geometry": {"type": "Point", "coordinates": [2, 2]}},
            {"type": "Feature", "properties": {"name": "Gamma City", "nameascii": "Gamma City", "adm0name": "Eastland", "adm0_a3": "EST", "pop_max": 800_000},
             "geometry": {"type": "Point", "coordinates": [15, 5]}},
        ],
    }  # fmt: skip
    c = tmp_path / "countries.geojson"
    p = tmp_path / "places.geojson"
    c.write_text(json.dumps(countries))
    p.write_text(json.dumps(places))
    return Geocoder(c, p)


@pytest.fixture
def pipeline(db: Database, tiny_geocoder: Geocoder, registry: Registry) -> IngestPipeline:
    return IngestPipeline(db, tiny_geocoder, registry, EventBus())


NOW = datetime(2026, 10, 1, 4, 0, 0)
