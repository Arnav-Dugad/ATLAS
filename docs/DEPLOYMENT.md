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

## Free public demo (GitHub Pages)

**https://arnav-dugad.github.io/ATLAS/** is a read-only snapshot that costs nothing to run.
A persistent Python process cannot be hosted for free, so the demo is static:

1. [`.github/workflows/pages.yml`](../.github/workflows/pages.yml) runs every 3 hours (and on
   pushes to `main` that touch the app, engine or registry). Actions minutes are free for
   public repositories.
2. It restores the previous engine state (DuckDB + HTTP cache) from the Actions cache, runs
   `atlas sync all`, and exports JSON that mirrors the API paths with `atlas export-static`.
   Incident histories, change logs and ETag revalidation carry over between runs.
3. The GHSL Population Pack is downloaded once and then restored from cache, so the snapshot
   includes population exposure for every incident.
4. The web app is built with `VITE_ATLAS_STATIC=1` and `ATLAS_BASE=/<repo>/`, and deployed
   with `actions/deploy-pages`.

In snapshot mode the client reads `snapshot/api/v1/*.json`, applies incident filters itself,
and shows **Snapshot · updated N ago** instead of the live indicator. Time windows are relative
to when the snapshot was taken, so an older snapshot never silently drops incidents.

| Capability | Local | Public snapshot |
|---|---|---|
| Live incidents, layers, correlation, severity, confidence | ✅ live | ✅ every 3 h |
| Population exposure (GHSL) | ✅ with pack | ✅ |
| OpenStreetMap infrastructure scan | ✅ on demand | — needs live Overpass |
| Weather context (Open-Meteo) | ✅ | — |
| Data Time Machine, archive search, NL queries | ✅ | — |
| SSE live stream, manual sync, health telemetry | ✅ | — |
| Historical earthquake replays (Demo Mode) | ✅ | ✅ |

Every unavailable feature says so in the UI and points to the local install. Nothing is
simulated to fill the gaps.

To publish your own fork: Settings → Pages → Source **GitHub Actions**, then run the
*Public demo* workflow.

Local test of the same build:

```bash
pnpm engine export-static ../../apps/web/public/snapshot     # path is relative to services/engine; stop `pnpm dev` first (DB lock)
cd apps/web && ATLAS_BASE=/ATLAS/ VITE_ATLAS_STATIC=1 npx vite build && ATLAS_BASE=/ATLAS/ npx vite preview
# Git Bash on Windows rewrites /ATLAS/ into a path; prefix both commands with MSYS_NO_PATHCONV=1
```

## Desktop (roadmap)
A Tauri shell around the static web build with the engine bundled as a sidecar — single
installer, same local-first behaviour. Electron is avoided for footprint.

## Configuration
See [`.env.example`](../.env.example). Every value is optional.
