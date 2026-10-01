# Deployment

ATLAS runs four ways, all free:

| Way | Who it is for | What you get |
|---|---|---|
| [Public snapshot](#public-snapshot-no-install) | Anyone with a browser, including phones | Read-only planet, rebuilt every 3 h |
| [Desktop app](#desktop-app-windows-macos-linux) | People who want the full live app without a terminal | Live engine bundled in one installer |
| [Local install](#local-full-capability) | Developers, analysts | Everything, including the local AI assistant |
| [Your own mirror](#host-your-own-mirror-cloudflare-pages-netlify-vercel) | Anyone with a free Cloudflare/Netlify/Vercel account | The public snapshot on your own URL |

## Public snapshot (no install)

**https://arnav-dugad.github.io/ATLAS/** — open it on any device with a WebGL2 browser.

- **Install it like an app.** Chrome/Edge: the install icon in the address bar. Android:
  menu → *Add to Home screen*. iPhone/iPad (Safari): Share → *Add to Home Screen*. It opens
  full-screen and the shell works offline; data refreshes when you are online.
- **Phones** get a dedicated layout: the globe on top, a bottom sheet with three snap points
  (drag the handle), and the incident panel as a full sheet.

### How it is built

A persistent Python process cannot be hosted for free, so the snapshot is static:

1. [`.github/workflows/pages.yml`](../.github/workflows/pages.yml) runs every 3 hours (and on
   pushes to `main` that touch the app, engine or registry). Actions minutes are free for
   public repositories.
2. It restores the previous engine state (DuckDB + HTTP cache) from the Actions cache, runs
   `atlas sync all`, and exports JSON that mirrors the API paths with `atlas export-static`.
   Incident histories, change logs and ETag revalidation carry over between runs.
3. The GHSL Population Pack is downloaded once and then restored from cache. The export also
   precomputes knowledge graphs for every incident, Sentinel-2 change maps for the top 6
   incidents, space weather, and (if the `ATLAS_OPENAQ_API_KEY` secret is set) air quality
   for the top 10.
4. The web app is built with `VITE_ATLAS_STATIC=1` and a relative base (`ATLAS_BASE=./`), so
   the same files work at any URL or sub-path. The result is deployed to GitHub Pages **and**
   force-pushed as a single orphan commit to the **`site` branch** (≈ 1,300 files, ≈ 18 MB),
   ready for any static host.

In snapshot mode the client reads `snapshot/api/v1/*.json`, applies incident filters itself,
and shows **Snapshot · updated N ago** instead of the live indicator. Time windows are relative
to when the snapshot was taken, so an older snapshot never silently drops incidents.

| Capability | Local / desktop | Public snapshot |
|---|---|---|
| Live incidents, layers, correlation, severity, confidence | ✅ live | ✅ every 3 h |
| Population exposure (GHSL) | ✅ with pack | ✅ |
| Knowledge graph, incident comparison, story mode, watchlists | ✅ | ✅ |
| Before/after imagery, 3D terrain | ✅ | ✅ |
| Sentinel-2 change analysis | ✅ any incident | ✅ top 6, precomputed |
| Earthquake scenarios (Simulation Lab) | ✅ with residents per band | ✅ bands only (computed in the browser) |
| Space weather | ✅ | ✅ |
| Air quality (OpenAQ) | ✅ with key | ✅ top 10, if the repo has the key |
| OpenStreetMap infrastructure scan, weather context | ✅ on demand | — needs live calls |
| Data Time Machine, archive search, NL archive queries | ✅ | — |
| Local AI assistant | ✅ with Ollama | — |
| SSE live stream, manual sync, health telemetry | ✅ | — |
| Historical earthquake replays (Demo Mode) | ✅ | ✅ |

Every unavailable feature says so in the UI and points to the local install. Nothing is
simulated to fill the gaps.

**Publishing your own fork:** Settings → Pages → Source **GitHub Actions**, then run the
*Public demo* workflow. Optional: Settings → Secrets and variables → Actions → add
`ATLAS_OPENAQ_API_KEY` (free key from [explore.openaq.org](https://explore.openaq.org/register))
to include air quality.

## Host your own mirror (Cloudflare Pages, Netlify, Vercel)

The `site` branch is a finished static site. No build step is needed; every host below is
free for this size, and `_headers` / `vercel.json` in the build set security and cache
headers.

### Cloudflare Pages — dashboard (no tokens)

1. [dash.cloudflare.com](https://dash.cloudflare.com) → **Workers & Pages** → **Create** →
   **Pages** → **Connect to Git**, and pick the ATLAS repository.
2. **Production branch:** `site`. **Framework preset:** None. **Build command:** leave
   empty. **Build output directory:** `/`.
3. **Save and Deploy.** Cloudflare redeploys automatically every time the workflow refreshes
   the `site` branch (8 times a day, well inside the free plan's 500 builds a month).

### Cloudflare Pages — from GitHub Actions (two secrets)

The workflow has an optional `cloudflare` job that uploads the same build with Wrangler:

1. Cloudflare → **My Profile → API Tokens → Create Token** → *Custom token* with
   **Account · Cloudflare Pages · Edit**. Copy your **Account ID** from the Workers & Pages
   overview.
2. GitHub → repository **Settings → Secrets and variables → Actions** → add secrets
   `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. Optionally add the variable
   `CLOUDFLARE_PAGES_PROJECT` (default `atlas-planetary`, which becomes
   `atlas-planetary.pages.dev`).
3. Run the *Public demo* workflow. Without the secrets the job is skipped.

### Netlify

**Add new site → Import an existing project** → the repository → **Branch to deploy:**
`site`, **Build command:** empty, **Publish directory:** `/` (leave the base directory empty).

### Vercel

**Add New → Project** → import the repository → **Framework preset:** Other, **Build
command:** override to empty, **Output directory:** `.` → Deploy. Then **Settings → Git →
Production Branch:** `site`. (The Hobby plan is for non-commercial use.)

## Desktop app (Windows, macOS, Linux)

A [Tauri 2](https://tauri.app) window around the web interface with the engine bundled as a
self-contained sidecar (PyInstaller), so nothing else needs installing. The engine starts with
the app on `127.0.0.1:8787`, keeps its data in the user's application-data folder, and stops
when the window closes.

- **Get it:** download the installer for your system from
  [Releases](https://github.com/Arnav-Dugad/ATLAS/releases) — Windows `.msi` or `-setup.exe`,
  macOS (Apple silicon) `.dmg`, Linux `.AppImage` or `.deb`.
- **Publish a new version:** push a `v*` tag; the *Desktop app* workflow builds all three
  platforms and attaches the installers to a **draft** release, which goes public only when a
  maintainer presses *Publish*. Running the workflow by hand gives the same installers as run
  artifacts.
- **Behaviour:** the window may open a few seconds before the engine; panels fill in by
  themselves. Closing the window stops the engine (it also stops itself if the app crashes).
- **Unsigned:** Windows SmartScreen → *More info → Run anyway*; macOS → right-click the app →
  *Open* the first time (or `xattr -dr com.apple.quarantine /Applications/ATLAS.app`).
- **Data folder:** `%LOCALAPPDATA%\ATLAS` (Windows), `~/Library/Application Support/ATLAS`
  (macOS), `~/.local/share/ATLAS` (Linux). The Core Pack (~11 MB) installs on first launch.
- **Optional extras:** the assistant works as soon as [Ollama](https://ollama.com) is running.
  The Population Pack has no in-app installer yet; from a local checkout run
  `ATLAS_DATA_DIR=<data folder> pnpm engine packs install population-ghsl`, then restart the app.
- **Build locally:** Rust (stable), Node 22 + pnpm, Python 3.12. See the workflow
  [`desktop.yml`](../.github/workflows/desktop.yml) for the exact steps (sidecar → web build
  with `VITE_ATLAS_API=http://127.0.0.1:8787` → `pnpm --filter @atlas/desktop tauri build`).

## Local (full capability)

```bash
pnpm setup     # Python venv + deps, web deps, DuckDB extensions, Core Pack (~11 MB)
pnpm dev       # engine on :8787 + web on :5173
```

Requirements: Node ≥ 20, pnpm ≥ 9, Python ≥ 3.11, a WebGL2-capable browser. ~200 MB disk
for the database and caches after a day of ingestion (FIRMS detections rotate on a 48 h
window). Optional:

- `pnpm engine packs install population-ghsl` (~484 MB) — residents in exposure rings and
  scenario bands.
- [Ollama](https://ollama.com) + `ollama pull qwen2.5:7b` — the local assistant (see [AI.md](AI.md)).
- Free keys in `.env` (git-ignored; see [`.env.example`](../.env.example)):
  `ATLAS_OPENAQ_API_KEY`, `ATLAS_FIRMS_MAP_KEY`, `ATLAS_RELIEFWEB_APPNAME`.

Production-style local run:

```bash
pnpm build                       # static web build in apps/web/dist
pnpm engine serve                # engine only
npx vite preview --port 4173     # from apps/web, serves the build (proxy /api to :8787)
```

### Engine-only / headless

```bash
pnpm engine sync all             # one-shot ingestion of every enabled source
pnpm engine serve --no-sync      # serve cached data without polling
ATLAS_OFFLINE=true pnpm engine serve   # never touch the network
```

### Local test of the snapshot build

```bash
pnpm engine export-static ../../apps/web/public/snapshot     # path is relative to services/engine; stop `pnpm dev` first (DB lock)
cd apps/web && ATLAS_BASE=./ VITE_ATLAS_STATIC=1 npx vite build && npx vite preview
```

End-to-end tests run the same build against a frozen real-data fixture:
`pnpm --filter @atlas/web e2e` (desktop and Pixel 7 viewports).

## Configuration
See [`.env.example`](../.env.example). Every value is optional. Secrets belong in `.env`
(git-ignored) locally and in GitHub Actions secrets for the snapshot; never commit them.
