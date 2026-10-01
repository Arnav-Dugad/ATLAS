"""Correlation, fusion, change detection and the full ingest pipeline."""

from __future__ import annotations

from datetime import datetime, timedelta

from atlas.engine.correlate import Correlator, IncidentKey, score
from atlas.engine.geocode import Geocoder
from atlas.engine.pipeline import IngestPipeline
from atlas.engine.query import parse
from atlas.engine.severity import assess as assess_severity
from atlas.models import ExternalRef, Hazard, Observation, TrackPoint
from tests.conftest import NOW


def quake(source: str, ext: str, lat: float, lon: float, mag: float, t: datetime, **kw: object) -> Observation:
    return Observation(source=source, external_id=ext, hazard=Hazard.EARTHQUAKE, title=f"M{mag}", lat=lat, lon=lon,
                       magnitude=mag, event_time=t, source_updated_at=t, depth_km=10.0, **kw)  # type: ignore[arg-type]  # fmt: skip


def storm(source: str, ext: str, name: str, lat: float, lon: float, t: datetime, wind: float = 50.0) -> Observation:
    return Observation(source=source, external_id=ext, hazard=Hazard.TROPICAL_CYCLONE, title=name, lat=lat, lon=lon,
                       event_time=t - timedelta(days=2), source_updated_at=t, names=[name], metrics={"max_wind_kt": wind},
                       status="current")  # fmt: skip


def key_for(o: Observation, iid: str = "I1") -> IncidentKey:
    k = IncidentKey(id=iid, hazard=o.hazard, lat=o.lat, lon=o.lon, started_at=o.event_time,
                    last_observation_at=o.source_updated_at or o.event_time, magnitude=o.magnitude)  # fmt: skip
    k.absorb(o)
    return k


class TestCorrelation:
    def test_same_quake_from_two_sources_matches(self) -> None:
        a = quake("usgs", "us1", 5.0, 5.0, 6.6, NOW)
        b = quake("gdacs", "EQ:1", 5.1, 5.05, 6.5, NOW + timedelta(seconds=1))
        assert score(b, key_for(a)) is not None

    def test_aftershock_is_not_merged_into_mainshock(self) -> None:
        main = quake("usgs", "us1", 5.0, 5.0, 7.0, NOW)
        after = quake("usgs", "us2", 5.05, 5.0, 5.2, NOW + timedelta(minutes=20))
        assert score(after, key_for(main)) is None

    def test_distant_simultaneous_quakes_not_merged(self) -> None:
        a = quake("usgs", "us1", 5.0, 5.0, 6.0, NOW)
        b = quake("gdacs", "EQ:2", 40.0, 140.0, 6.0, NOW)
        assert score(b, key_for(a)) is None

    def test_storm_names_link_across_formats(self) -> None:
        nhc = storm("nhc", "ep182026", "Rachel", 19.2, -108.5, NOW)
        gdacs = storm("gdacs", "TC:1", "RACHEL-26", 18.0, -107.0, NOW)
        assert score(gdacs, key_for(nhc)) is not None

    def test_differently_named_storms_never_merge(self) -> None:
        a = storm("nhc", "ep1", "Rachel", 19.0, -108.0, NOW)
        b = storm("gdacs", "TC:2", "POLO-26", 19.5, -108.2, NOW)
        assert score(b, key_for(a)) is None

    def test_external_ids_win(self) -> None:
        corr = Correlator([])
        iid, method = corr.match(quake("gdacs", "EQ:9", 0, 0, 5, NOW), ["ATL-EQ-2026-AAAA"])
        assert iid == "ATL-EQ-2026-AAAA" and method == "external-id"


class TestSeverity:
    def test_earthquake_bands_and_pager_floor(self) -> None:
        assert assess_severity(Hazard.EARTHQUAKE, [quake("usgs", "a", 0, 0, 5.4, NOW)]).level == 2
        assert assess_severity(Hazard.EARTHQUAKE, [quake("usgs", "a", 0, 0, 7.8, NOW)]).level == 4
        orange = quake("usgs", "a", 0, 0, 5.4, NOW, alert_level="orange")
        sev = assess_severity(Hazard.EARTHQUAKE, [orange])
        assert sev.level == 4 and "PAGER" in sev.basis

    def test_gdacs_peak_wind_is_not_current_intensity(self) -> None:
        peak = Observation(source="gdacs", external_id="TC:1", hazard=Hazard.TROPICAL_CYCLONE, title="POLO-26", lat=30, lon=-108,
                           event_time=NOW - timedelta(days=9), metrics={"peak_wind_kt": 155.0})  # fmt: skip
        current = storm("eonet", "E1", "Polo", 30, -108, NOW, wind=30)
        sev = assess_severity(Hazard.TROPICAL_CYCLONE, [peak, current])
        assert sev.level == 1 and "Latest max sustained wind 30 kt" in sev.basis

    def test_cyclone_wind_bands(self) -> None:
        assert assess_severity(Hazard.TROPICAL_CYCLONE, [storm("nhc", "x", "A", 0, 0, NOW, wind=30)]).level == 1
        assert assess_severity(Hazard.TROPICAL_CYCLONE, [storm("nhc", "x", "A", 0, 0, NOW, wind=140)]).level == 5


class TestPipeline:
    def test_quake_lifecycle(self, pipeline: IngestPipeline) -> None:
        usgs = quake("usgs", "us1", 5.0, 5.0, 6.8, NOW - timedelta(minutes=30), status="automatic",
                     external_refs=[ExternalRef(scheme="usgs", id="us1")])  # fmt: skip
        rep = pipeline.ingest("usgs", [usgs], complete_snapshot=False, now=NOW)
        assert len(rep.incidents_created) == 1
        iid = rep.incidents_created[0]

        # GDACS reports the same event and references the USGS id -> linked, not duplicated
        gd = quake("gdacs", "EQ:1", 5.02, 5.01, 6.7, NOW - timedelta(minutes=30), alert_level="green",
                   external_refs=[ExternalRef(scheme="gdacs", id="EQ:1"), ExternalRef(scheme="usgs", id="us1")])  # fmt: skip
        rep2 = pipeline.ingest("gdacs", [gd], complete_snapshot=True, now=NOW)
        assert rep2.incidents_created == [] and rep2.incidents_updated == [iid]

        # USGS revises the magnitude upward -> audited change + severity change
        revised = usgs.model_copy(update={"magnitude": 7.1, "status": "reviewed"})
        rep3 = pipeline.ingest("usgs", [revised], complete_snapshot=False, now=NOW + timedelta(minutes=10))
        kinds = {c.kind for c in rep3.changes}
        assert {"magnitude_revised", "reviewed", "severity_changed"} <= kinds

        with pipeline.db.read() as cur:
            inc = cur.execute("SELECT source_count, severity_level, title FROM incidents WHERE id = ?", [iid]).fetchone()
            versions = cur.execute("SELECT count(*) FROM observation_versions WHERE observation_id = 'usgs:us1'").fetchone()
        assert inc[0] == 2 and inc[1] == 4
        assert inc[2].startswith("M7.1 earthquake")
        assert versions[0] == 2  # append-only history for the Data Time Machine

    def test_unchanged_reingest_is_idempotent(self, pipeline: IngestPipeline) -> None:
        o = quake("usgs", "us5", 1.0, 1.0, 5.0, NOW)
        pipeline.ingest("usgs", [o], complete_snapshot=False, now=NOW)
        rep = pipeline.ingest("usgs", [o], complete_snapshot=False, now=NOW + timedelta(minutes=1))
        assert rep.unchanged == 1 and rep.changed == 0 and rep.incidents_created == []

    def test_small_quakes_do_not_open_incidents(self, pipeline: IngestPipeline) -> None:
        o = quake("usgs", "tiny", 1.0, 1.0, 2.1, NOW).model_copy(update={"incident_candidate": False})
        rep = pipeline.ingest("usgs", [o], complete_snapshot=False, now=NOW)
        assert rep.inserted == 1 and rep.incidents_created == []

    def test_storm_track_and_dissipation(self, pipeline: IngestPipeline) -> None:
        s = storm("nhc", "ep1", "Rachel", 6.0, 6.0, NOW, wind=80)
        s.track = [TrackPoint(time=NOW, lat=6.0, lon=6.0, wind_kt=80, source="nhc")]
        rep = pipeline.ingest("nhc", [s], complete_snapshot=True, now=NOW)
        iid = rep.incidents_created[0]
        # Next snapshot no longer contains the storm; two days later it is no longer active
        pipeline.ingest("nhc", [], complete_snapshot=True, now=NOW + timedelta(hours=1))
        pipeline.sweep(now=NOW + timedelta(days=2))
        with pipeline.db.read() as cur:
            status = cur.execute("SELECT status FROM incidents WHERE id = ?", [iid]).fetchone()[0]
        assert status in ("monitoring", "closed")

    def test_geocoding_in_titles(self, pipeline: IngestPipeline) -> None:
        o = quake("usgs", "geo", 5.3, 5.3, 6.0, NOW)
        iid = pipeline.ingest("usgs", [o], complete_snapshot=False, now=NOW).incidents_created[0]
        with pipeline.db.read() as cur:
            title, iso3 = cur.execute("SELECT title, country_iso3 FROM incidents WHERE id = ?", [iid]).fetchone()
        assert iso3 == "WST"
        assert "of Alpha, Westland" in title


class TestGeocoder:
    def test_country_and_offshore(self, tiny_geocoder: Geocoder) -> None:
        hit = tiny_geocoder.country(5, 5)
        assert hit is not None and hit.iso3 == "WST" and hit.offshore_km == 0
        off = tiny_geocoder.country(-1, 5)  # ~111 km south of Westland
        assert off is not None and off.iso3 == "WST" and 100 < off.offshore_km < 120
        assert tiny_geocoder.country(-30, 5) is None

    def test_description_convention(self, tiny_geocoder: Geocoder) -> None:
        place = tiny_geocoder.describe(5.5, 5.0)
        assert place is not None
        assert place.name == "Alpha" and place.compass == "N"
        assert place.description.endswith("N of Alpha, Westland")

    def test_search(self, tiny_geocoder: Geocoder) -> None:
        assert tiny_geocoder.search("gam")[0]["name"] == "Gamma City"
        assert tiny_geocoder.search_countries("east")[0]["iso3"] == "EST"


class TestQueryParser:
    def test_full_example(self, tiny_geocoder: Geocoder) -> None:
        q = parse("earthquakes above magnitude 6 in Westland during 2024", tiny_geocoder, NOW)
        assert q.hazards == ["earthquake"]
        assert q.min_magnitude == 6.0
        assert q.start == datetime(2024, 1, 1) and q.end == datetime(2025, 1, 1)
        assert q.country_iso3 == "WST"
        assert q.needs_archive

    def test_relative_windows_and_unsupported(self, tiny_geocoder: Geocoder) -> None:
        q = parse("floods affecting more than 500,000 people in the last 7 days", tiny_geocoder, NOW)
        assert q.hazards == ["flood"]
        assert q.start == NOW - timedelta(days=7)
        assert q.unsupported and "Population" in q.unsupported[0]

    def test_m_plus_shorthand(self, tiny_geocoder: Geocoder) -> None:
        q = parse("M5+ near Gamma City", tiny_geocoder, NOW)
        assert q.min_magnitude == 5.0 and q.hazards == ["earthquake"]
        assert q.place and q.place["name"] == "Gamma City"

    def test_tropical_storm_not_double_counted(self, tiny_geocoder: Geocoder) -> None:
        q = parse("tropical storms this week", tiny_geocoder, NOW)
        assert q.hazards == ["tropical_cyclone"]
