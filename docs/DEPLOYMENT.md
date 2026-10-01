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
- **Data folder:** `%LOCALAPPDATA%\org.atlas.planetary` (Windows, next to the app's WebView2
  profile; 0.1.0 used the install folder `%LOCALAPPDATA%\ATLAS` and its data moves over
  automatically), `~/Library/Application Support/ATLAS` (macOS), `~/.local/share/ATLAS` (Linux).
  The Core Pack (~11 MB) installs on first launch.
- **Assistant:** works as soon as [Ollama](https://ollama.com) is running.

### Windows app: Settings (`Ctrl+,` or the gear in the top bar)

The Windows build has a Settings window; the website and the macOS/Linux builds are unchanged.

| Section | What it does |
|---|---|
| Data sources | Paste an **OpenAQ API key**, a **ReliefWeb appname** or an **HDX HAPI app identifier** with the sign-up steps alongside; each is checked against the service when saved and applies at once (no restart). Keys are encrypted for the Windows user with DPAPI in `credentials.json`; only the last four characters are ever shown. |
| Data packs | Install the **Population Pack** (~484 MB) with progress, **import a copy you already downloaded** (it finds `…\data\runtime\packs\population-ghsl` in ATLAS checkouts under Desktop, Documents, Downloads and similar folders, or takes a path), or remove it. |
| Offline areas | Save the area on screen (up to 6° across, 8,000 tiles) at a chosen detail level — Sentinel-2 cloudless imagery, the Blue Marble backdrop and terrain — so the globe keeps working there without internet. Progress, size and delete per area. |
| Appearance | **Solid** panels (default: opaque, higher-contrast, no backdrop blur) or **Glass**; high contrast; reduced motion; idle rotation; accent colour, density, layout, units; **language** (English / हिन्दी beta); **start view** (whole planet / India). |
| Graphics | **Automatic** (default: High on a dedicated GPU, Battery saver on integrated graphics), Battery saver, Balanced or High; shows the GPU in use. |
| About & storage | Engine version, data folder (copy), privacy notes. |

The Windows app also opens maximised and passes `--force_high_performance_gpu` to WebView2
(`tauri.windows.conf.json`), so laptops with two GPUs draw the globe on the dedicated one. On
the development laptop (Intel UHD + RTX 4060, 1536×824 at 125 %) the globe went from ~15 fps
(Intel, glass, High) to a steady 60 fps (RTX), and Battery saver holds 60 fps page refresh
on the Intel GPU alone.
### Windows app: native integration

| Feature | How it behaves |
|---|---|
| One copy at a time | Starting ATLAS again focuses the open window (and passes on any jump-list action or `atlas://` link) instead of starting a second engine. |
| Free port | The engine uses 8787, or any free port when 8787 is taken; the window learns the port before it loads. |
| Background and tray | Closing the window can leave ATLAS watching in the tray (Settings → App); the tray menu reopens it, plays the planet story or quits. **Start with Windows** starts it quietly in the tray. |
| Notifications | Watch-area alerts appear as Windows notifications. |
| Jump list | Right-click the taskbar icon: Play the planet story, Watch areas, Search, Settings. |
| `atlas://` links | `atlas://incident/ATL-EQ-2026-XXXXXXXX` opens ATLAS on that incident (registered for your Windows user when ATLAS first runs). |
| Links | External links open in your default browser. |
| Diagnostics | Settings → App → Export diagnostics zips logs and settings (never keys) for a bug report. |
| Startup | The engine ships as a folder, not a self-extracting file, so it starts without unpacking ~100 MB each time. |
| Offline areas | Base imagery and terrain load through the local engine (`/api/v1/tiles/…`), which serves saved areas first. |

### Windows app: automatic updates

The app checks `https://github.com/Arnav-Dugad/ATLAS/releases/latest/download/latest.json`
(Settings → App → Check for updates) and installs updates signed with the ATLAS updater key.

- The *Desktop app* workflow signs the installer with the repository secrets
  `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` and writes `latest.json`
  into the **draft** release.
- **Updates reach people only after the draft release is published** (GitHub's "latest release"
  never points at a draft).
- Keep a private backup of the updater key (`atlas-updater.key` and its password). If it is
  lost, installed copies cannot verify future updates and must be reinstalled by hand.

### Windows code signing (free for open source)

Unsigned installers trigger SmartScreen's "Windows protected your PC". The
[SignPath Foundation](https://signpath.org/) signs open-source projects free of charge with its
own certificate:

1. Read the conditions (OSI licence, public source, builds from CI, no malware or PUP behaviour)
   and apply at <https://signpath.org/apply> with the repository URL.
2. Once accepted, install the SignPath GitHub App on the repository and add the
   organisation id, project slug, signing-policy slug and an API token as repository secrets.
3. In `desktop.yml`, upload the unsigned `.exe`/`.msi` as an artifact and add the
   `signpath/github-action-submit-signing-request` step to sign them before the release step.

SmartScreen reputation still builds up over the first downloads even when signed; an EV
certificate would skip that but is not free.

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
