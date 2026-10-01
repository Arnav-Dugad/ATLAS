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

## Phase 2 — Exposure & history
- GHSL population exposure (5/10/25/50 km rings, by intensity band) via windowed raster reads
- OpenStreetMap infrastructure exposure via Overpass (hospitals, schools, airports, ports, power, bridges) with per-incident caching
- Historical time machine for all layers: playback controls (1× … 1 month/sec)
- Static public demo snapshots (GitHub Pages)

## Phase 3 — Satellite intelligence
- Before/after comparison slider (GIBS dates; Sentinel-2 via Copernicus Data Space)
- Derived indices (NDVI/NDWI/NBR) where scientifically defensible, with method notes
- Terrain (Terrarium heightmaps) and storm-cone 3D extrusion

## Phase 4 — Local AI
- Ollama/llama.cpp assistant over typed read-only tools with citations (see `AI.md`)

## Phase 5 — Analysis
- Simulation Lab (see `SIMULATION.md`), knowledge graph explorer, event comparison,
  story mode, offline region packs, watchlists with desktop notifications

## Phase 6 — Breadth & polish
- More sources (ReliefWeb with appname, OpenAQ with key, national agencies, river gauges)
- Tauri desktop app, performance profiles (Eco → Extreme), visual regression suite
