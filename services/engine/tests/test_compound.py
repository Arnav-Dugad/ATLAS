from __future__ import annotations

from atlas.engine.compound import fire_weather, heat_days


def test_heatwave_needs_three_hot_days_above_both_thresholds() -> None:
    hot, run = heat_days([30.0, 36.0, 37.5, 36.2, 31.0, None], p90=35.0)
    assert hot == [False, True, True, True, False, False]
    assert run == 3
    # above the local 90th percentile but not hot in absolute terms (a mild winter day)
    hot, run = heat_days([18.0, 19.0, 20.0], p90=12.0)
    assert run == 0


def test_fire_weather_counts_hours_that_are_both_dry_and_windy() -> None:
    fw = fire_weather(
        {
            "time": ["2026-10-01T00:00", "2026-10-01T01:00", "2026-10-01T02:00"],
            "relative_humidity_2m": [20, 40, 18],
            "wind_speed_10m": [35, 50, 12],
        }
    )
    assert fw is not None
    assert fw["hours"] == 1 and fw["first"] == "2026-10-01T00:00"
    assert fw["min_rh"] == 18 and fw["max_wind_kmh"] == 50
