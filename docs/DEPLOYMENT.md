# Deployment

## Local (full capability) — recommended

```bash
pnpm setup     # Python venv + deps, web deps, DuckDB extensions, Core Pack (~11 MB)
pnpm dev       # engine on :8787 + web on :5173
```

Requirements: Node ≥ 20, pnpm ≥ 9, Python ≥ 3.11, a WebGL2-capable browser. ~200 MB disk
for the database and caches after a day of ingestion (FIRMS detections rotate on a 48 h
window). Optional: `pnpm engine packs install population-ghsl` (~484 MB).

Production-style local run:

```bash
pnpm build                       # static web build in apps/web/dist
pnpm engine serve                # engine only
npx vite preview --port 4173     # from apps/web, serves the build (proxy /api to :8787)
```

## Engine-only / headless

```bash
pnpm engine sync all             # one-shot ingestion of every enabled source
pnpm engine serve --no-sync      # serve cached data without polling
ATLAS_OFFLINE=true pnpm engine serve   # never touch the network
```

## Free public demo (planned)

A public demo cannot run a persistent Python process for free, so it will be static:

1. A scheduled GitHub Actions workflow (free for public repos) runs `atlas sync all`
   headless every 30–60 minutes.
2. It exports snapshot JSON (`overview`, `incidents`, layer columns, incident details) and
   publishes them with the web build to GitHub Pages.
3. The web client detects the static mode and reads snapshots instead of the live API.

Differences from local: no SSE live stream, no archive search, no manual refresh, no Data
Time Machine beyond what the snapshot includes. These will be stated in the UI.

## Desktop (roadmap)
A Tauri shell around the static web build with the engine bundled as a sidecar — single
installer, same local-first behaviour. Electron is avoided for footprint.

## Configuration
See [`.env.example`](../.env.example). Every value is optional.
