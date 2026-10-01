# Simulation Lab (planned — Phase 5)

Simulations answer "what if?", never "what will happen". Every output is stamped
**SIMULATION — NOT A FORECAST**, uses the `simulation` provenance class, renders in a
distinct amber style, and is never mixed into the live incident stream.

## Planned scenarios

| Scenario | Method sketch | Inputs | Honest limits |
|---|---|---|---|
| Earthquake shaking radius | Published GMPE/intensity-attenuation relation (documented), not ShakeMap | magnitude, depth, location | No site amplification; illustrative bands only |
| Hypothetical storm path | User-drawn track + wind-radius envelope | track, intensity, radii | No dynamics; exposure along a drawn path |
| Wildfire spread approximation | Elliptical spread from wind and slope (Rothermel-style simplification) | ignition, wind (Open-Meteo), terrain | Fuel models unavailable globally; for teaching, not operations |
| Flood scenario | Bathtub fill on DEM with connectivity | water level, DEM | Ignores hydraulics and defences |
| Infrastructure outage | Graph cut on OSM network | removed nodes/edges | OSM completeness varies |
| Evacuation routing | Shortest paths avoiding hazard polygons | OSM roads | Not authoritative routing |

Each scenario will ship with its method page, parameters echoed in the output, and a
side-by-side comparison against real observations where they exist.
