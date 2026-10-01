"""Phase 5: earthquake shaking scenarios and the incident knowledge graph."""

from __future__ import annotations

import math
from datetime import timedelta

import pytest

from atlas.engine import relations, simulation
from atlas.engine.pipeline import IngestPipeline
from atlas.models import ExternalRef, Hazard, Observation
from tests.conftest import NOW


class TestShakingScenario:
    def test_matches_hand_computed_reference(self) -> None:
        # M7, R_hypo = 20 km: Rm = -0.209 + 2.042·e² = 14.88; ln √(20² + 14.88²) = 3.2163
        # MMI = 2.085 + 1.428·7 − 1.402·3.2163 = 7.572
        assert simulation.mmi(7.0, 20.0) == pytest.approx(7.572, abs=0.005)
        # beyond 50 km the anelastic term applies: + 0.078·ln(R/50)
        r = 120.0
        rm = -0.209 + 2.042 * math.exp(1.0)
        expected = 2.085 + 1.428 * 6.0 - 1.402 * math.log(math.hypot(r, rm)) + 0.078 * math.log(r / 50)
        assert simulation.mmi(6.0, r) == pytest.approx(expected, abs=1e-9)

    def test_intensity_falls_with_distance_and_rises_with_magnitude(self) -> None:
        values = [simulation.mmi(6.5, r) for r in (5, 20, 60, 150, 400)]
        assert values == sorted(values, reverse=True)
        assert simulation.mmi(7.5, 50) > simulation.mmi(6.5, 50)

    def test_band_radius_is_where_median_intensity_reaches_the_level(self) -> None:
        r = simulation.radius_km(6, 6.8, 10)
        assert r is not None and simulation.mmi(6.8, math.hypot(r, 10)) == pytest.approx(6.0, abs=0.01)
        assert simulation.radius_km(10, 5.0, 10) is None  # a M5 never reaches X at the epicentre

    def test_scenario_counts_residents_per_band_and_labels_itself(self) -> None:
        class Grid:
            def rings(self, _lat: float, _lon: float, radii: list[float]) -> list[float]:
                return [1000.0 * r for r in radii]  # cumulative residents grow with radius

        out = simulation.scenario(35.0, 139.0, 7.0, 15.0, Grid())  # type: ignore[arg-type]
        assert out["provenance"] == "simulation" and out["label"] == "SIMULATION — NOT A FORECAST"
        bands = out["bands"]
        assert [b["level"] for b in bands] == sorted((b["level"] for b in bands), reverse=True)
        assert all(b["residents_in_band"] >= 0 for b in bands)
        assert sum(b["residents_in_band"] for b in bands) == bands[-1]["residents_within"]
        assert out["caveats"] and "not a forecast" in out["caveats"][0]

    def test_inputs_are_bounded_and_out_of_range_use_is_flagged(self) -> None:
        with pytest.raises(ValueError):
            simulation.validate(0, 0, 9.8, 10)
        with pytest.raises(ValueError):
            simulation.validate(0, 0, 6, 0)
        notes = simulation.validate(0, 0, 8.4, 60)
        assert any("calibration" in n for n in notes) and any("crustal" in n for n in notes)
        no_pop = simulation.scenario(0, 0, 6.0, 10, None)
        assert no_pop["population_note"] and "residents_within" not in no_pop["bands"][0]


def node(nid: str, hazard: str, lat: float, lon: float, days: float, mag: float | None = None, last_days: float | None = None,
         bbox: tuple[float, float, float, float] | None = None) -> relations.Node:  # fmt: skip
    t = NOW + timedelta(days=days)
    return relations.Node(
        nid, nid, hazard, 2, "active", lat, lon, t, NOW + timedelta(days=last_days if last_days is not None else days), mag, bbox
    )


class TestRelations:
    def test_gardner_knopoff_windows(self) -> None:
        km, days = relations.gk_window(6.0)
        assert km == pytest.approx(53.2, abs=0.2) and days == pytest.approx(499, abs=2)
        km, days = relations.gk_window(7.0)
        assert km == pytest.approx(70.7, abs=0.3) and days == pytest.approx(918, abs=3)

    def test_aftershock_and_foreshock_inside_the_window(self) -> None:
        main = node("main", "earthquake", 0.0, 0.0, 0, 6.8)
        after = node("after", "earthquake", 0.3, 0.0, 2, 5.1)  # ~33 km, 2 days later
        fore = node("fore", "earthquake", 0.1, 0.1, -1, 5.0)
        far = node("far", "earthquake", 5.0, 5.0, 1, 5.0)
        e = relations.relate(after, main)
        assert (
            e is not None and (e.source, e.target, e.type) == ("main", "after", "aftershock") and "Gardner–Knopoff" in e.evidence
        )
        e = relations.relate(main, fore)
        assert e is not None and e.type == "foreshock"
        assert relations.relate(main, far) is None
        assert relations.relate(main, node("bigger", "earthquake", 0.1, 0.0, 1, 7.2)).type == "foreshock"  # type: ignore[union-attr]

    def test_cyclone_flood_volcano_and_neighbour_rules(self) -> None:
        cyc = node("cyc", "tropical_cyclone", 20.0, 120.0, 0, last_days=4, bbox=(118.0, 15.0, 125.0, 22.0))
        flood = node("flood", "flood", 16.0, 121.0, 6)
        late_flood = node("late", "flood", 16.0, 121.0, 30)
        assert relations.relate(cyc, flood).type == "cyclone_flood"  # type: ignore[union-attr]
        assert relations.relate(cyc, late_flood) is None
        volc = node("volc", "volcano", -7.54, 110.45, 0)
        quake = node("q", "earthquake", -7.6, 110.5, 3, 4.6)
        assert relations.relate(quake, volc).type == "volcano_earthquake"  # type: ignore[union-attr]
        f1, f2 = node("f1", "wildfire", 10.0, 10.0, 0), node("f2", "wildfire", 10.3, 10.0, 2)
        assert relations.relate(f1, f2).type == "nearby"  # type: ignore[union-attr]
        assert relations.relate(f1, node("f3", "wildfire", 12.0, 10.0, 0)) is None

    def test_graph_from_ingested_observations(self, pipeline: IngestPipeline) -> None:
        def quake(ext: str, lat: float, lon: float, mag: float, hours: float) -> Observation:
            t = NOW + timedelta(hours=hours)
            return Observation(source="usgs", external_id=ext, hazard=Hazard.EARTHQUAKE, title=f"M{mag}", lat=lat, lon=lon, magnitude=mag,
                               depth_km=10, event_time=t, source_updated_at=t, external_refs=[ExternalRef(scheme="usgs", id=ext)])  # fmt: skip

        pipeline.ingest(
            "usgs",
            [quake("m", 5.0, 5.0, 6.9, 0), quake("a", 5.2, 5.1, 5.2, 20), quake("x", 8.0, 8.0, 5.0, 10)],
            complete_snapshot=False,
        )
        with pipeline.db.read() as cur:
            ids = {r[0]: r[1] for r in cur.execute("SELECT external_id, incident_id FROM observations").fetchall()}
            g = relations.graph(cur, ids["m"], depth=2)
        assert g is not None
        assert {n["id"] for n in g["nodes"]} == {ids["m"], ids["a"]}
        assert g["edges"] == [
            {
                "source": ids["m"],
                "target": ids["a"],
                "type": "aftershock",
                "label": "M5.2 aftershock of M6.9",
                "evidence": g["edges"][0]["evidence"],
            }
        ]
        assert g["method"] == relations.METHOD
