# Data Sources

The authoritative, machine-readable registry is
[`data/registry/sources.json`](../data/registry/sources.json); it drives the in-app **Sources**
view and the engine's network allow-list. This document records the **research behind each
entry**: endpoint verification, authentication, limits, licensing and caveats.

**Verification date for everything below: 2026-10-01.** Each endpoint was requested live; the
observed status and payload shape are noted.

## Summary

| Source | Status in ATLAS | Auth | Licence | Cadence used |
|---|---|---|---|---|
| USGS Earthquake Hazards Program | ✅ live connector | none | Public domain | 1 min / 10 min / 1 h feeds |
| GDACS | ✅ live connector | none | CC BY | 10 min |
| NOAA National Hurricane Center | ✅ live connector | none | Public domain | 15 min |
| NASA EONET v3 | ✅ live connector | none | NASA open data | 20 min |
| Smithsonian / USGS Weekly Volcanic Activity Report | ✅ live connector | none | Public domain, citation requested | 6 h |
| NASA FIRMS (VIIRS NOAA-20/21, S-NPP, MODIS) | ✅ live connector | none (public CSV) | NASA open data | 30 min |
| NASA GIBS | ✅ browser imagery | none | NASA open data | per view |
| EOxCloudless Sentinel-2 2024 | ✅ browser basemap | none | Non-commercial with attribution | per view |
| Natural Earth | ✅ Core Pack | none | Public domain | once |
| Open-Meteo | ✅ on demand | none | CC BY 4.0 data, non-commercial free tier | on incident open |
| ReliefWeb API v2 | ⏸ adapter, disabled | **approved appname** | per-document | 30 min when enabled |
| OpenAQ v3 | ✅ on demand (with key) | **free API key** | CC BY 4.0 platform; provider licences vary | per incident, cached 15 min |
| OpenStreetMap / Overpass | ✅ on demand | none | ODbL | per incident, cached 24 h |
| GHSL GHS-POP R2023A | ✅ Population Pack | none | CC BY 4.0 | once (~484 MB) |
| Sentinel-2 L2A (Earth Search STAC + AWS COGs) | ✅ on demand | none | Copernicus open data | per analysis |
| EMSC-CSEM (FDSN event service) | ✅ live connector | none | CC BY 4.0 | 5 min |
| NOAA Tsunami Warning Centers (NTWC, PTWC) | ✅ live connector | none | Public domain | 3 min |
| NOAA SWPC (NOAA scales) | ✅ overview context | none | Public domain | 10 min |
| Terrain Tiles (Terrarium, AWS Open Data) | ✅ browser terrain | none | mixed open, attribution list | per view |

## Details

### USGS Earthquake Hazards Program
- **Endpoints**: `https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/{all_hour,all_day,2.5_week,significant_month}.geojson`; FDSN `https://earthquake.usgs.gov/fdsnws/event/1/query` for archive queries.
- **Verified**: HTTP 200, GeoJSON FeatureCollection (`metadata.api = 2.7.0`, 238 events in `all_day`). FDSN query for 2023-02-06 M7+ returned the two Kahramanmaraş mainshocks.
- **Fields used**: `mag`, `magType`, `place`, `time`, `updated`, `alert` (PAGER), `status` (automatic/reviewed/deleted), `tsunami`, `sig`, `felt`, `cdi`, `mmi`, `ids`, `types`; geometry `[lon, lat, depth_km]`.
- **Caveats**: automatic solutions are revised; some ComCat place strings contain `?` where a non-ASCII letter was lost (e.g. `?arai` for Ōarai) — ATLAS substitutes its own place description for archive results. Non-earthquake types (quarry blasts, explosions) are filtered.
- **Attribution**: "Earthquake data: U.S. Geological Survey (USGS)".

### GDACS
- **Endpoints**: `https://www.gdacs.org/gdacsapi/api/events/geteventlist/EVENTS4APP` (current events, GeoJSON); per-episode geometry `…/polygons/getgeometry?eventtype=&eventid=&episodeid=`.
- **Verified**: 100 features (EQ, TC, FL, DR, WF). Geometry for cyclones contains past/forecast track points (`Point_Polygon_Point_n`, key `MMDDhhmm`), category segments, an uncertainty cone (`Poly_Cones`) and 60/90/120 km/h wind buffers; earthquake geometry contains `sourceid` = USGS event id.
- **Important semantics**: cyclone `severitydata.severity` is the **lifetime maximum wind**, not current intensity (verified against NHC: Rachel GDACS 194 km/h vs NHC current 80 kt). ATLAS stores it as `peak_wind_kt`.
- **Licence**: CC BY. GDACS states its information is indicative and should not be used for decision making without other sources.
- **Attribution**: "Alerts: GDACS (European Commission JRC & UN OCHA), CC BY".

### NOAA National Hurricane Center
- **Endpoint**: `https://www.nhc.noaa.gov/CurrentStorms.json`.
- **Units verified against the public advisory text**: `intensity` in **knots** (80 ↔ "90 mph"), `movementSpeed` in **mph** (7 ↔ "near 7 mph"), `pressure` in mb.
- **Coverage**: Atlantic, Eastern and Central Pacific only.

### NASA EONET v3
- **Endpoint**: `https://eonet.gsfc.nasa.gov/api/v3/events?status=open&days=30`.
- **Verified**: 188 open events (wildfires, severe storms, sea/lake ice). Storm geometries carry `magnitudeValue` in kts per fix; wildfire magnitudes in acres.
- **Caveat**: events are often left open for days after a storm dissipates — ATLAS judges storm liveness by the newest fix.

### Smithsonian / USGS Weekly Volcanic Activity Report
- **Endpoint**: `https://volcano.si.edu/news/WeeklyVolcanoRSS.xml` (20 items, GeoRSS points).
- **Licence**: product of U.S. Government employees (public domain); citation requested. The terms page is behind a bot check; terms confirmed via the GVP citation guidance.
- **Parsing**: `defusedxml` (no entity expansion / XXE); HTML descriptions reduced to text.

### NASA FIRMS
- **Endpoints (no key)**: `https://firms.modaps.eosdis.nasa.gov/data/active_fire/{noaa-20-viirs-c2,noaa-21-viirs-c2,suomi-npp-viirs-c2,modis-c6.1}/csv/*_Global_24h.csv`.
- **Verified**: 200, ~1.4–8 MB each, `ETag` and `Last-Modified` present (conditional requests work).
- **Optional MAP_KEY** (free) unlocks area/historical API queries — not required.
- **Citation**: "We acknowledge the use of data from the NASA LANCE FIRMS (https://earthdata.nasa.gov/firms), part of the NASA Earth Science Data and Information System (ESDIS)."

### NASA GIBS
- **Endpoint pattern**: `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/{Layer}/default/{Date}/GoogleMapsCompatible_Level{N}/{z}/{y}/{x}.{ext}`.
- **Verified from GetCapabilities (1,319 layers)**: layers used include `BlueMarble_ShadedRelief_Bathymetry` (L8), `VIIRS_Black_Marble` (L8), `VIIRS_NOAA20_CorrectedReflectance_TrueColor` (L9, daily), `IMERG_Precipitation_Rate` (L6), `GHRSST_L4_MUR_Sea_Surface_Temperature` (L7), `TROPOMI_L2_Nitrogen_Dioxide_Tropospheric_Column` (L6), `TROPOMI_L2_Sulfur_Dioxide_Total_Vertical_Column` (L6), `MODIS_Terra_Aerosol` (L6), `MODIS_Terra_Land_Surface_Temp_Day` (L7), `MODIS_Combined_Flood_2-Day` (L9), `OPERA_L3_Dynamic_Surface_Water_Extent-Sentinel-1` (L12), `MODIS_Terra_NDVI_8Day` (L9), `GPW_Population_Density_2020` (L7), `ASTER_GDEM_Color_Shaded_Relief` (L12), `Reference_Labels_15m` (L13).
- **Caveat**: rendered visualisations, not calibrated values.

### EOxCloudless (Sentinel-2 cloudless 2024)
- **Endpoint**: `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2024_3857/default/g/{z}/{y}/{x}.jpg`.
- **Licence**: free for non-commercial use with attribution "EOxCloudless https://cloudless.eox.at by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2024)"; commercial use needs an EOX licence. ATLAS (non-commercial, open source) loads tiles in the browser only.

### Natural Earth
- **Files (Core Pack)**: `ne_50m_admin_0_countries`, `ne_110m_admin_0_countries`, `ne_10m_populated_places_simple`, `ne_50m_admin_1_states_provinces` (GeoJSON from the official `nvkelso/natural-earth-vector` repository). Public domain.

### Open-Meteo
- **Endpoint**: `https://api.open-meteo.com/v1/forecast`.
- **Free tier** (non-commercial): 600/min, 5,000/h, 10,000/day, 300,000/month. Data CC BY 4.0. ATLAS rounds coordinates to 0.05° and caches 30 min.

### ReliefWeb API v2 — disabled by default
- **Verified behaviour**: `v1` returns HTTP 410 (decommissioned); `v2` without an approved appname returns HTTP 403 `"You are not using an approved appname"`.
- **To enable**: request an appname at https://apidoc.reliefweb.int/parameters#appname (since 1 November 2025 appnames must be pre-approved; the page links a short form, appnames combine your name or organisation, the purpose and random characters, and ReliefWeb replies by email — verified 2026-10-01). Then set `ATLAS_RELIEFWEB_APPNAME`, or paste it in the Windows app under Settings → Data sources. The adapter normalises `/v2/disasters` and links via GLIDE numbers.

### OpenAQ v3 — air quality near an incident
`GET https://api.openaq.org/v3/locations?coordinates=lat,lon&radius=25000` and
`/v3/locations/{id}/latest` with an `X-API-Key` header (free key; verified 2026-10-01: 60
requests/min). Many listed stations are long inactive (one Delhi station last reported in
2018), so only stations that reported in the last 24 h are used; values are shown as
measured, with provider and time. `/v3/parameters/{id}/latest` ignored the coordinate filter
in testing and is not used. The key lives in `.env` (git-ignored) or a CI secret.

### OpenStreetMap / Overpass — Phase 2
- `overpass-api.de/api/status` responded (4 slots). Per-incident extracts are cached 24 h with a 2 s minimum spacing per request. ODbL attribution "© OpenStreetMap contributors".

### GHSL GHS-POP R2023A — optional Population Pack
- `GHS_POP_E2025_GLOBE_R2023A_4326_30ss_V1_0.zip` — HTTP 200, 483,694,490 bytes, CC BY 4.0. Installed with `pnpm engine packs install population-ghsl`; extraction is guarded against archive bombs and path traversal.

### Sentinel-2 L2A via Earth Search — Phase 3
`GET https://earth-search.aws.element84.com/v1/search?collections=sentinel-2-l2a&bbox=…&datetime=…&sortby=-properties.datetime`
returned GeoJSON items (verified 2026-10-01: 32 items for a 0.2° box over 55 days) with
`assets.{nir,swir22,green,swir16,red,scl,visual}` pointing at cloud-optimised GeoTIFFs on
`sentinel-cogs.s3.us-west-2.amazonaws.com`, and `raster:bands` scale 0.0001 / offset −0.1.
A 700 × 700 overview window read with rasterio took ~3.6 s. No key, no account. Asset URLs
are accepted only from that bucket (https). Attribution: "Contains modified Copernicus
Sentinel data [year], processed by ATLAS".

### EMSC-CSEM — Phase 6
`GET https://www.seismicportal.eu/fdsnws/event/1/query?format=json&starttime=…&minmag=4&orderby=time`
returned GeoJSON (verified 2026-10-01) with `properties.{unid, time, lastupdate, lat, lon,
depth, mag, magtype, flynn_region, evtype, auth, source_catalog}`. The service pages state the
data are CC BY 4.0. Event pages: `https://www.seismicportal.eu/eventdetails.html?unid=…`.
EMSC matches USGS incidents through the ordinary earthquake rule (origin within 150 s,
120 km, |ΔM| ≤ 1.0); incidents need M ≥ 4.5, as for USGS.

### NOAA Tsunami Warning Centers — Phase 6
Atom feeds `https://www.tsunami.gov/events/xml/PAAQAtom.xml` (NTWC) and `PHEBAtom.xml`
(PTWC) returned 200 (verified 2026-10-01). Each entry carries the category, issue time,
preliminary magnitude, epicentre, affected region, a bulletin link and a CAP document.
Parsed with defusedxml; ATLAS links to the bulletin and never rewrites its guidance.

### NOAA SWPC — Phase 6
`https://services.swpc.noaa.gov/products/noaa-scales.json` gives the current R/S/G levels
and SWPC's three-day outlook (verified 2026-10-01). Shown on the overview as attributed
context; the outlook is SWPC's forecast, quoted as issued.

### Terrain Tiles (Terrarium) — Phase 3
`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png` returned 200 with
`Access-Control-Allow-Origin: *` (verified 2026-10-01). Height = R·256 + G + B/256 − 32768 m.
The required per-source attribution list (tilezen/joerd `docs/attribution.md`) is shown in
the attribution panel whenever terrain is on.

## Adding a source

1. Add the registry entry (all fields required; record verification in this file).
2. Implement a `DataConnector` in `services/engine/src/atlas/connectors/` and register it in `connectors/__init__.py`.
3. Add a trimmed real payload under `tests/fixtures/` and connector tests.
4. If the source has a licence obligation, it appears automatically in attribution views and exports via the registry.
