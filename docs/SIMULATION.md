# Simulation Lab

Simulations answer "what if?", never "what will happen". Every output is stamped
**SIMULATION — NOT A FORECAST**, uses the `simulation` provenance class, renders in a
distinct amber style, and is never mixed into the live incident stream.

## Shipped: earthquake shaking scenario

Open it from **Layers → Tools → Scenario**, from the command palette (*simulation lab*) or
from any earthquake incident (**Scenario** re-runs the real event with another magnitude or
depth). Click anywhere on the globe to place the epicentre.

**Method.** Allen, Wald & Worden (2012), *Intensity attenuation for active crustal regions*,
J. Seismology 16:409–433, hypocentral-distance form, with the coefficients as implemented in
the GEM OpenQuake engine (`AllenEtAl2012Rhypo`):

```
MMI(M, R) = c0 + c1·M + c2·ln(√(R² + Rm²)) + [R > 50 km] · c4·ln(R / 50)
Rm        = m1 + m2·exp(M − 5)
σ(R)      = s1 + s2 / (1 + (R / s3)²)

c0 2.085 · c1 1.428 · c2 −1.402 · c4 0.078 · m1 −0.209 · m2 2.042 · s1 0.82 · s2 0.37 · s3 22.9
```

R is the hypocentral distance √(epicentral² + depth²). For each intensity level IV–X+ ATLAS
solves for the epicentral radius where the median intensity falls to that level, draws the
bands on the globe in the USGS ShakeMap colour legend, and counts residents in each annulus
from the GHSL 2025 population grid (when the Population Pack is installed; the public
snapshot computes the same equation in the browser and shows residents as unavailable).

**Inputs and limits.** Magnitude 4.0–9.5, depth 1–300 km. Outside the calibration range
(about M 5–7.9, shallow crustal), the result carries an explicit note.

**What it does not do.** It does not estimate damage, casualties or losses, does not model
site amplification, rupture extent or directivity, and says nothing about whether or when an
earthquake will happen. The caveats are shown with every result and included in exports.

**Example.** An M7.3 at 10 km depth gives median MMI ≥ VIII within ~11 km of the epicentre,
≥ VII within ~46 km, ≥ VI within ~106 km and ≥ IV out to ~490 km; IX is not reached by the
median at any distance. The engine (`test_simulation_relations.py`) and the browser port
(`simulation.test.ts`) are tested against the same reference values.

## Planned scenarios

| Scenario | Method sketch | Inputs | Honest limits |
|---|---|---|---|
| Hypothetical storm path | User-drawn track + wind-radius envelope | track, intensity, radii | No dynamics; exposure along a drawn path |
| Wildfire spread approximation | Elliptical spread from wind and slope (Rothermel-style simplification) | ignition, wind (Open-Meteo), terrain | Fuel models unavailable globally; for teaching, not operations |
| Flood scenario | Bathtub fill on DEM with connectivity | water level, DEM | Ignores hydraulics and defences |
| Infrastructure outage | Graph cut on OSM network | removed nodes/edges | OSM completeness varies |
| Evacuation routing | Shortest paths avoiding hazard polygons | OSM roads | Not authoritative routing |

Each scenario will ship with its method page, parameters echoed in the output, and a
side-by-side comparison against real observations where they exist.
