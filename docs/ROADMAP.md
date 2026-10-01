# Roadmap

ATLAS is built vertically: each phase is usable end to end before the next begins.

## ✅ Phase 1 — Foundation (shipped)
- Monorepo, design system, typed API contract, CI
- CesiumJS planetary view: Sentinel-2 cloudless, real-time sun, city lights, atmosphere
- Canonical event model with provenance; DuckDB store with append-only history
- Connectors: USGS, GDACS (+ geometry), NHC, NASA EONET, Smithsonian GVP, NASA FIRMS
- Correlation engine, fusion, severity scale, confidence heuristic, audit trail
- FIRMS clustering (H3 union-find), cluster identity, static-source heuristic
- Live SSE stream, incident stream, intelligence panel, chronology, Data Time Machine
- Command palette with deterministic natural-language queries + USGS archive
- Timeline histogram, GIBS layer manager (13 overlays), registry and health views
- Exports (Markdown brief, JSON, GeoJSON) with attribution

## Phase 2 — Exposure & history (in progress)
- ✅ GHSL population exposure: ring table per incident + "Population within" headline metric; population filters in natural-language queries
- ✅ OpenStreetMap infrastructure exposure via Overpass (11 categories, exact per-ring counts, nearest named facilities, globe markers), cached 24 h
- Population by intensity band (ShakeMap MMI contours) where USGS publishes them
- ✅ Historical playback: transport (1 h/s, 6 h/s, 1 d/s), scrubbing, sun-synced lighting, earthquake arrival ripples, incident onsets; current-state layers hidden during replay
- Playback for fires (archive detections) and cyclone tracks over time
- ✅ Free public demo: static snapshot on GitHub Pages, rebuilt every 3 h by Actions with rolling engine state and population exposure

## ✅ Phase 3 — Satellite intelligence
- ✅ Before/after split comparison on the globe (four NASA GIBS daily products, any two dates)
- ✅ Sentinel-2 change analysis per incident: dNBR burn severity, MNDWI new water, ΔNDVI —
  scene search, cross-tile mosaics, SCL masking, class areas, swipe viewer, globe drape;
  precomputed for major incidents in the public snapshot
- ✅ 3D terrain from open elevation tiles with relief exaggeration
- Storm-cone 3D extrusion

## ✅ Phase 4 — Local AI
- ✅ ATLAS Analyst: a local Ollama model (loopback only) over 8 typed, read-only tools, with
  citations, streamed answers and prompt-injection defences (see `AI.md`)
- llama.cpp server as a second backend

## Phase 5 — Analysis
- ✅ Simulation Lab: earthquake shaking scenarios (Allen, Wald & Worden 2012) with residents
  per intensity band (see `SIMULATION.md`)
- ✅ Knowledge graph: rule-based relations (aftershock windows, cyclone → flood, volcano–quake,
  neighbours) in the Links tab and as arcs on the globe
- ✅ Side-by-side comparison of up to three pinned incidents
- ✅ Story mode: a guided tour of up to six significant open incidents, captioned only from ATLAS data
- ✅ Watchlists with browser/desktop notifications, stored only on the device
- Storm-path, wildfire-spread and flood scenarios; offline region packs (imagery + terrain)

## Phase 6 — Breadth & polish
- ✅ EMSC earthquakes (independent corroboration), NOAA tsunami-centre messages (official
  bulletins, severity floors), NOAA SWPC space weather on the overview
- ✅ OpenAQ air quality near incidents (free key; included in the public snapshot)
- ✅ Installable web app (PWA) with a phone layout; host-anywhere static build (`site` branch)
- ✅ Tauri desktop app with the engine bundled as a sidecar, built by CI for Windows, macOS and Linux
- ✅ End-to-end tests on desktop and phone viewports against a frozen real-data fixture
- More sources (ReliefWeb with appname, national agencies, river gauges)
- Performance profiles (Eco → Extreme), visual regression suite, signed installers
