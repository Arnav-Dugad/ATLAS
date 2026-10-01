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
2. **Tsunami messages** (NOAA NTWC/PTWC) attach to the earthquake they follow: issued up to
   3 h after its origin time, within 400 km of its epicentre, preliminary magnitude within
   1.0. Information statements only attach; warnings, watches, advisories and threat
   messages may open an incident.
3. **Space–time–name scoring** with hazard-specific tolerances:

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

## ATLAS Severity Scale v1.2

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
- Official NOAA tsunami warning (NTWC/PTWC) → 5; tsunami watch, advisory or threat message → ≥ 4
- Volcanoes: GVP "new activity" → 3, ongoing → 2; aviation colour ORANGE → 3, RED → 4

**v1.1 change (2026-10-01):** GDACS's cyclone wind is the storm's *lifetime peak*, not its
current intensity. Current intensity now comes only from NHC advisories or EONET's latest
fix; the GDACS peak is shown separately as *Lifetime peak wind* and used (one level lower)
only when no current value exists. Methodology changes are written to the audit trail as
`reassessed` events, never as real-world changes.

**v1.2 change (2026-10-01):** official tsunami messages from the NOAA warning centres raise
an earthquake incident's floor (above). The earthquake magnitude comes from USGS, then EMSC;
a tsunami bulletin's preliminary magnitude is never used as the magnitude.

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

## Satellite change analysis (Phase 3) — `atlas-spectral-v1`

On request (or precomputed for a few major incidents in the public snapshot) ATLAS compares
two Sentinel-2 L2A passes around an incident. Provenance **Derived**.

**Window.** The incident footprint plus 15 % margin, or a hazard-sized square (wildfire ±6 km,
flood/cyclone ±15 km, volcano ±8 km, earthquake ±10 km), capped at 40 km. The grid is
EPSG:4326 at ≥ 10 m and ≤ 768 px on the long side; each band is read from the COG overview
whose resolution matches the grid, so only small windows are fetched.

**Scenes.** Earth Search (STAC) is queried for the 45 days before onset and for onset → now.
Items of one pass (same satellite, same day) are mosaicked across MGRS tiles; the latest
processing baseline of each tile wins. Passes whose tile cloud cover is ≤ 20 % are tried
first, then ≤ 50 %, then the rest; a pass is accepted when ≥ 80 % of the window is clear
in the Scene Classification Layer (fallback: the clearest tried, if ≥ 35 %).

**Masking.** Pixels are compared only where *both* dates are clear: SCL classes 4, 5, 7 (and
2 "dark area / topographic shadow" for burn and water indices, because fresh burn scars and
water are dark), plus 6 (water) for MNDWI. No masked pixel is filled or extrapolated; the
valid share is reported. Reflectance = DN × scale + offset from the item metadata
(baseline ≥ 04.00 offset −0.1).

| Hazard | Index | Classes |
|---|---|---|
| Wildfire | dNBR = NBR_before − NBR_after, NBR = (B08 − B12)/(B08 + B12) — Key & Benson 2006 | USGS FIREMON ranges: < −0.25 enhanced regrowth (high), −0.25…−0.10 (low), −0.10…0.10 unburned, 0.10…0.27 low, 0.27…0.44 moderate-low, 0.44…0.66 moderate-high, ≥ 0.66 high severity |
| Flood, cyclone | MNDWI = (B03 − B11)/(B03 + B11) — Xu 2006 | water where MNDWI > 0 → new water / water on both dates / receded |
| Other | ΔNDVI = NDVI_after − NDVI_before | ≤ −0.2 loss, ≥ +0.2 gain (heuristic threshold, labelled as such) |

Areas use the latitude-corrected area of each pixel row. Headline: burned area (dNBR ≥ 0.10),
new surface water, or vegetation loss. Caveats shown with every result: no field
validation (CBI), smoke and thin cloud the SCL misses, fires still active in the after scene,
optical blindness to flooded vegetation and urban flooding (radar would help), and season,
harvest, tides and phenology between dates.

## Before / after imagery and terrain

The split comparison shows NASA GIBS daily composites as delivered (no enhancement); the
default "before" date reaches back 6 days for fires and 5 for floods and cyclones, because
detection can lag a start. 3D terrain samples the AWS Terrain Tiles (Terrarium) into the
globe's geographic tiling and clamps heights at 0 m, so it is visual relief only.

## Knowledge graph — `atlas-relations-v1`

The **Links** tab and the arcs on the globe connect incidents by documented rules. Every edge
names its rule and evidence (distance, time gap, magnitudes). These are spatial–temporal
associations, not proof of cause, except for the aftershock convention:

| Relation | Rule |
|---|---|
| Aftershock / foreshock | Gardner & Knopoff (1974) windows, as fitted by van Stiphout et al. (2012, CORSSA): L(M) = 10^(0.1238·M + 0.983) km; T(M) = 10^(0.032·M + 2.7389) d for M ≥ 6.5, else 10^(0.5409·M − 0.547) d. A smaller event inside the larger event's window is an aftershock (after) or foreshock (before). In a sequence, members link only to the mainshock. |
| Possibly cyclone-related flood | Flood onset between the cyclone's start and 7 days after its last data, within 300 km of the track extent |
| Earthquake near volcano | Within 30 km and 30 days |
| Same-hazard neighbours | Wildfires ≤ 60 km / 5 d; floods ≤ 300 km / 14 d; other hazards ≤ 150 km / 10 d |

## Simulation Lab

Earthquake shaking scenarios use the Allen, Wald & Worden (2012) intensity prediction
equation. Provenance **Simulation**, never mixed with observations. Method, coefficients and
limits are documented in [SIMULATION.md](SIMULATION.md).

## Air quality near an incident (OpenAQ)

With a free OpenAQ key, ATLAS lists up to 5 monitoring stations within 25 km that reported in
the last 24 hours (OpenAQ also lists long-dead stations), with the latest PM2.5, PM10, NO₂,
O₃, SO₂ and CO values **as measured** (provenance **Observed**): station, provider, distance
and time. Values are not averaged, interpolated or converted. WHO 2021 24-hour guidelines are
shown for context, with the caveat that one hourly reading is indicative only. Low-cost sensor
networks and reference monitors are both listed; the provider is shown for each.

## Space weather (NOAA SWPC)

The overview shows SWPC's current R (radio blackout), S (solar radiation storm) and G
(geomagnetic storm) levels and SWPC's own three-day outlook, verbatim and attributed. A
geomagnetic storm has no single location, so it is context, not an incident.

## Watchlists

A watch is a circle (centre, radius 25–1000 km), optional hazard filter and minimum severity,
stored only in the browser. Matching runs on the open incidents the client already has
(great-circle distance from the incident's position to the centre). Alerts fire once per incident and never
for the backlog that existed when the watch was created, using the browser's Notification API
if the person allows it. Nothing is sent to a server.

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

## Earthquake intelligence — quoted, matched and counted

* **Official USGS products** (REAL, quoted as issued): PAGER alert and residents per shaking
  intensity, ShakeMap `cont_mmi` contours, and the origin's horizontal/depth uncertainty,
  station count and azimuthal gap. The uncertainty circle on the globe uses the USGS
  `horizontal-error`. The **aftershock forecast** table is the USGS OAF product exactly as
  published (model, issue time, next update); ATLAS computes no aftershock forecast.
* **Source agreement** (DERIVED): latest USGS vs EMSC magnitude, epicentre distance and depth;
  flagged when they differ by ≥ 0.3 units, ≥ 25 km or ≥ 20 km. Neither value is preferred.
* **National agencies** (REAL): JMA, NCS India and INCOIS reports matched to the USGS solution
  within 2–5 minutes and 150–300 km, shown separately with the time and distance between them.
* **Historical analogs** (REAL): M5.5+ within 300 km since 1900 from ComCat (incl. ISC-GEM),
  largest first.
* **Activity this week** (DERIVED): M4+ within 200 km in the last 7 days (*k*) against the mean
  weekly count over the ten years before (*λ*). Reported with *k/λ* and the Poisson tail
  *p* = P(X ≥ *k* | λ). Verdicts: "above usual" when *p* < 0.05, "far above usual" when
  *p* < 0.001. Aftershocks are counted, catalogue completeness varies, and this describes the
  present only.

## Fire growth — `atlas-growth-v1`

FIRMS detections of the last 48 h for an incident's clusters, in 6-hour windows. Each H3
resolution-9 cell (~0.1 km²) counts once, in the window it first burned: "new ground" per window
and the cumulative footprint. Spread = bearing and distance from the centroid of cells that
burned earlier to the centroid of cells that first burned in the last 12 h (shown only if
≥ 1 km). The multi-day history sums each merged cluster's latest footprint. Detections are
375 m–1 km pixels seen at overpasses; a footprint is an indicator, not a mapped burn scar.

## Rapid intensification

The NHC definition, ≥ 30 kt increase in maximum sustained wind within 24 h, checked on pairs of
reported winds 22–26 h apart. Observed track and agency forecast are evaluated separately; the
forecast line restates the agency's forecast.

## What's inside the cone

Residents (GHSL, cell centres inside) and the largest Natural Earth places inside the published
forecast cone and GDACS wind swaths (60/90/120 km/h). GDACS swaths cover the whole track, past
and forecast. Population is read in 5° tiles so large cones never load the whole window.

## Radar flood mapping — `atlas-radar-v1`

Sentinel-1 RTC (VV, γ⁰ linear). The newest pass since onset is compared with the latest earlier
pass from the same relative orbit and direction. 5×5 mean in linear power (speckle), then dB;
water where VV < −18 dB (a common default, e.g. Twele et al. 2016). New water = water after and
not before. Only land is analysed: Natural Earth 1:10m land minus a 500 m coastal margin, because
calm sea after a windy pass reads as new water. Smooth dry surfaces look like water; flooded
vegetation and towns are often missed.

## Burn-scar gallery

Every 6 h the engine runs the Sentinel-2 dNBR analysis (`atlas-spectral-v1`) for up to four of
the largest active wildfires without a fresh result. Results are the same as a requested
analysis and carry the same caveats.

## Compound conditions and compound events

* **Heat** (MODEL vs climatology): forecast daily maximum above the 90th percentile of ERA5 daily
  maxima for the same ±7 days in 2010–2024 and ≥ 25 °C; three or more consecutive such days is
  called a heatwave (percentile-based, cf. Perkins & Alexander 2013).
* **Fire weather** (MODEL): hours in the next 48 h with relative humidity ≤ 25 % and wind
  ≥ 30 km/h together — a generic screen, not an official fire-danger rating.
* **Air quality** (REAL): highest PM2.5 within 25 km; above 35.4 µg/m³ is "unhealthy for sensitive
  groups" on the US EPA scale (a 24 h standard, applied to hourly readings — stated).
* **Compound events** (DERIVED): active incidents of two or more hazard types linked through pairs
  of *different* hazards within 300 km (union–find), so dense fields of one hazard never group.

## Rivers

GloFAS v4 discharge for the wettest 5 km cell within ±0.05° of the incident (3×3 probe), today's
value ranked against the previous two years at that cell; the forecast is GloFAS's ensemble
(median and range). USGS gauges: latest stage/discharge within ~40 km reported in the last 3 days.

## Population comparison and buildings

WorldPop 2020 (constrained, 100 m) counts the same rings as GHSL (up to 100 km); both and their
ratio are shown — the spread is model uncertainty. Overture Maps building footprints are counted
within 1/2/5/10 km by bounding-box centre; mapped footprints only.

## Measuring

Great-circle distance and spherical polygon area on a sphere of radius 6,371.0088 km (within
~0.5 % of the ellipsoid). Inside a drawn area: GHSL residents with cell centres inside, and
OpenStreetMap facility counts via Overpass `poly:` (skipped above 5,000 km²). Elevation profiles
sample Copernicus DEM GLO-30 at 64 points.

## Situation report

Built only from ATLAS records with fixed templates; each sentence lists the sources and ATLAS
records behind it as numbered references. Nothing is generated freely; the local analyst can be
asked separately and cites its own facts.
