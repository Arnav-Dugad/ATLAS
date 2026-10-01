# Methodology

ATLAS deals with real events affecting real people. Every derived number in the interface
follows a documented method, and every method states its limits. Nothing here is a
prediction; ATLAS reports, correlates and summarises what authoritative sources observed or
modelled.

## Provenance classes

Every metric carries one of:

| Class | Meaning | Examples |
|---|---|---|
| **Observed** (`real`) | Reported by an authoritative source | USGS magnitude, NHC max sustained wind, observatory alert level |
| **Derived** (`derived`) | Computed by ATLAS from real data with a deterministic method | Saffir–Simpson category, fire-cluster footprint, distance travelled |
| **Model estimate** (`model`) | Output of an identified model | USGS PAGER, ShakeMap MMI, GDACS alert level, Open-Meteo weather |
| **Simulation** (`simulation`) | Hypothetical scenario — never an observation | (Simulation Lab, roadmap) |
| **Unavailable** | Not enough reliable information | Population exposure without the Population Pack |

## Correlation (one real event → one incident)

Order of evidence (`engine/correlate.py`):

1. **Shared external identifiers**: the USGS event id embedded in GDACS earthquake geometry,
   GLIDE numbers, NHC storm ids, GDACS ids referenced by EONET. They win unless the pair is
   contradictory: different storm names or depression numbers, or more than 2,500 km apart
   and outside the incident's extent. Upstream identifiers are occasionally reused (GDACS
   once issued the same GLIDE number, `TC-2026-000184-MEX`, to storms Polo and Nolo), so a
   rejected link is logged and the observation falls through to scoring.
2. **Space–time–name scoring** with hazard-specific tolerances:

| Hazard | Max distance | Max time gap | Extra rules |
|---|---|---|---|
| Earthquake | 120 km | 150 s **between origin times** | \|ΔM\| ≤ 1.0 — aftershocks never merge into the mainshock |
| Tropical cyclone | 350 km from the latest position (2,500 km if names match ≥ 0.88) | 3 days | Proper names are identifiers: storms whose names match < 0.88 never merge (Polo ≠ Nolo). A numbered depression (`Nineteen-E`) may link to its later name; two different numbers never merge |
| Wildfire | 25 km (0 inside the incident's bbox) | 10 days | |
| Volcano | 30 km (60 km with name match) | 45 days | |
| Flood | 300 km | 14 days | Country must agree unless very close |
| Drought | 1,500 km | 120 days | |

Score = `1 − 0.5·(distance/allowed) − 0.3·(gap/max_gap) + 0.4·[name match]`; the best
positive score wins. Storm names are normalised (`"Tropical Storm Hanna"`, `"HANNA-26"` →
`hanna`). For storms the incident's bounding box is not used as a shortcut, because a
track's extent can enclose a different, later storm. Tolerances reflect feed positional and timing uncertainty and are unit-tested.

## ATLAS Severity Scale v1.1

An **ordinal intensity scale (0–5)** used to sort and colour incidents of different hazard
types consistently. It is **not** a risk or impact estimate. The basis string shown in the
interface names every input that set the level; the highest applicable rule wins.

| Level | Label | Earthquake (magnitude) | Tropical cyclone (current sustained wind) | Wildfire (Σ FRP 48 h) | Wildfire (reported burned area) |
|---|---|---|---|---|---|
| 1 | Minor | < 5.0 | < 34 kt | < 2,500 MW | < 1,000 ha |
| 2 | Moderate | 5.0–5.9 | 34–63 kt (tropical storm) | ≥ 2,500 MW | ≥ 1,000 ha |
| 3 | Significant | 6.0–6.9 | 64–95 kt (Cat 1–2) | ≥ 10,000 MW | ≥ 10,000 ha |
| 4 | Severe | 7.0–7.9 | 96–112 kt (Cat 3) | ≥ 25,000 MW | ≥ 50,000 ha |
| 5 | Extreme | ≥ 8.0 | ≥ 113 kt (Cat 4–5) | ≥ 75,000 MW | ≥ 200,000 ha |

Floors from impact models and flags (each labelled as such):

- USGS PAGER yellow → ≥ 3, orange → ≥ 4, red → 5 (loss model)
- GDACS orange → ≥ 4, red → 5 (impact model); green floods/droughts → 2
- USGS tsunami flag → ≥ 3
- Volcanoes: GVP "new activity" → 3, ongoing → 2; aviation colour ORANGE → 3, RED → 4

**v1.1 change (2026-10-01):** GDACS's cyclone wind is the storm's *lifetime peak*, not its
current intensity. Current intensity now comes only from NHC advisories or EONET's latest
fix; the GDACS peak is shown separately as *Lifetime peak wind* and used (one level lower)
only when no current value exists. Methodology changes are written to the audit trail as
`reassessed` events, never as real-world changes.

## ATLAS Confidence Heuristic v1

Summarises how well-supported an incident's core facts are. Shown as a label plus every
component; **not a calibrated probability**.

| Component | Weight | Scoring |
|---|---|---|
| Corroboration | 0.30 | Independent lines of evidence: 1 → 0.55, 2 → 0.75, 3+ → 0.90. Dependent pairs count 0.4 (GDACS EQ echoes USGS; EONET/GDACS storms echo NHC). |
| Source authority | 0.25 | Best registry reliability rating: A = 1.0, B = 0.8, C = 0.6 |
| Review status (earthquakes) | 0.20 | USGS reviewed = 1.0, automatic = 0.65 |
| Source agreement | 0.15 | EQ: magnitude spread ≤ 0.2 and ≤ 20 km → 1.0; ≤ 0.5 and ≤ 50 km → 0.8; else 0.5. TC: wind spread ≤ 10 kt → 1.0, ≤ 25 kt → 0.8 |
| Freshness (active only) | 0.10 | Age vs source cadence: ≤ 2× → 1.0, ≤ 6× → 0.7, else 0.4 |

Labels: ≥ 0.85 very high · ≥ 0.70 high · ≥ 0.50 moderate · else low.

## Incident lifecycle

| Hazard | Active while | Then monitoring for | Notes |
|---|---|---|---|
| Earthquake | 72 h after origin (7 days if PAGER/GDACS orange or red) | 14 days | |
| Tropical cyclone | A complete-snapshot source still lists it **and** its newest fix is < 24 h old | 3 days | Fixes, not feed modification times, decide liveness |
| Wildfire | Cluster present in the latest FIRMS run, or GDACS/EONET still open | 5 days | |
| Volcano | GVP report < 10 days or GDACS current | 30 days | |
| Flood / drought | GDACS current | 14 / 90 days | |

Incidents open only for observations that clear a hazard threshold (e.g. M ≥ 4.5, PAGER
alert, tsunami flag or USGS significance ≥ 600). Everything else stays visible as a layer.

## Active fire clusters (NASA FIRMS)

1. VIIRS (375 m) and MODIS (1 km) detections from the public global 24 h files are bulk
   loaded by DuckDB and kept for a rolling 48 h window, de-duplicated by
   instrument/satellite/position/time.
2. Each detection is indexed to H3 r7 (~5.2 km²) and r9 (~0.105 km²).
3. **Clusters** = connected components of occupied r7 cells under 1-ring adjacency (union–find).
4. **Active footprint** = distinct r9 cells × mean r9 area — the area of burning pixels,
   *never* a burn perimeter.
5. **Identity** persists across runs by maximum r7-cell overlap; splits get new ids.
6. **Possible static sources** (gas flares, industry, volcanoes): ≥ 8 detections within
   0.8 km of the centroid across ≥ 3 acquisitions. Tracked, never incident-forming.
7. **Incident-grade** clusters: ≥ 120 detections and Σ FRP ≥ 2,500 MW in 48 h (calibrated on
   2026-10-01 global data: ~5,300 tracked clusters, ~100 incident-grade).
8. **12 h trend**: detections in the last 12 h vs the preceding 12 h; satellite overpass
   timing affects short-term trends, which the interface notes.

## Exposure (Phase 2)

Exposure is **descriptive**: what lies within geodesic distance rings of the incident
position. It is never an estimate of damage, casualties or people affected.

| Hazard | Rings (km) | Headline "Population within" ring |
|---|---|---|
| Earthquake, volcano | 5 · 10 · 25 · 50 | 25 km (EQ), 10 km (VO) |
| Wildfire, landslide | 5 · 10 · 25 | 10 km |
| Tropical cyclone, severe storm | 25 · 50 · 100 (around the current position) | 100 km |
| Flood, drought | — (area hazards; polygon exposure on the roadmap) | — |

**Population** — GHSL GHS-POP R2023A, epoch 2025, 30 arc-seconds (~1 km), CC BY 4.0
(optional Population Pack). Cells whose centres fall inside a ring are summed using windowed
reads of the tiled GeoTIFF (2–15 ms per incident). Provenance **Model estimate**: the grid is
a modelled disaggregation of census counts representing residential (night-time) population.
Headline values are rounded to the nearest hundred above 1,000.

**Infrastructure** — OpenStreetMap via the public Overpass API, on demand only (never
polled). One request per incident selects each of 11 facility categories within the largest
ring, then filters that set for each smaller ring (`out count`) — exact counts without
downloading features. Named critical facilities (hospitals, fire stations, shelters,
airports, ports, water works) are listed by distance (capped at 800). Results are cached
24 h per ~100 m-rounded centre. Provenance **Derived**; OSM completeness varies strongly by
country, so absence of a mapped facility is not absence of the facility.

## Geocoding

Point-in-polygon against Natural Earth 1:50m countries (STRtree), with a nearest-coastline
fallback up to 400 km ("offshore ~259 km"). Place descriptions follow the USGS convention
— *distance and compass bearing from the nearest town to the event* — using the nearest
populated place within 60 km, else the nearest place with ≥ 100k people. Generalised
boundaries make attribution near borders approximate.

## Data Time Machine

Every material revision of an observation is appended to `observation_versions`. The
knowledge endpoint reconstructs, for any instant *T*, the latest version of each
observation recorded at or before *T* — i.e. what *this ATLAS instance* knew at that time.
