# Security

ATLAS treats every upstream byte as untrusted and runs locally with no telemetry.

## Threat model highlights

| Threat | Mitigation |
|---|---|
| SSRF via links inside feeds | `UrlPolicy`: https only, no credentials, no IP literals, no `localhost`/`.local`, and **only hosts declared in the source registry** may be fetched. |
| Oversized / endless responses | Declared `Content-Length` check plus a streamed byte ceiling per request (default 64 MB; tighter per connector). Hard connect/read timeouts. |
| Hammering free services | Fresh-cache short-circuit, conditional requests, per-host concurrency + spacing, exponential backoff with full jitter, `Retry-After` honoured, 4xx fail fast, manual refresh cooldown (30 s). |
| XML entity expansion / XXE | All XML parsed with `defusedxml`; bombs are rejected (covered by tests). |
| Malicious HTML in reports | Converted to plain text by an allow-nothing extractor (scripts/styles dropped). The UI never renders upstream HTML. |
| Unsafe links rendered to users | `safe_external_link` keeps only `http(s)` without credentials; links open with `rel="noreferrer noopener"`. |
| Archive bombs / path traversal in data packs | Member path validation, flattening, compression-ratio limit (200:1), total extraction ceiling (8 GiB), SHA-256 recorded in pack manifests. |
| Malformed upstream data | Pydantic validation, coordinate/time/depth sanity checks; rejected records are counted per sync run and visible in the registry. |
| Stack traces leaking to clients | Global exception handler returns structured errors only. |
| Browser hardening | CSP meta tag (self + imagery hosts), API sets `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Cross-Origin-Resource-Policy`, CSP `frame-ancestors 'none'`, `Permissions-Policy`. |
| Secrets | Only optional keys (OpenAQ key, ReliefWeb appname, HDX HAPI app identifier — which encodes an email, so it is treated as a secret), read from environment / `.env` (gitignored). Stored as `SecretStr`; never logged or sent to the client. In the Windows app, keys entered in Settings are encrypted with DPAPI for the current Windows user (`credentials.json` in the data folder); the API returns only "set" and the last four characters. |
| A web page driving the local Settings API | Settings endpoints exist only in the Windows app, require the Host to be the loopback engine (no DNS rebinding) and any browser `Origin` to be the app's own; state changes need JSON bodies, so browsers must preflight them and CORS refuses other origins. Pack imports copy only the pack's own file types (`.tif`, `.geojson`, `.json`) from a folder holding a matching ATLAS manifest. |
| Product files named inside upstream documents | USGS product files are fetched only when their URL is `https://earthquake.usgs.gov`; Sentinel-1 assets only from the Planetary Computer blob host (with a short-lived anonymous token); INCOIS bulletin links only from `tsunami.incois.gov.in`. Anything else is ignored, not followed. |
| Official alert text | NWS, SACHET (CAP 1.2), MeteoAlarm and SIGMET text is whitespace-normalised, length-capped and rendered as plain text; links are kept only on the issuing agency's host; CAP is parsed with `defusedxml`. |
| TLS to servers with broken chains | `tsunami.incois.gov.in` omits its intermediate certificate. Instead of disabling verification, the engine adds that public GlobalSign intermediate (fingerprint in `http/certs/intermediates.pem`) to certifi's roots; hostname checks and `CERT_REQUIRED` stay on (tested). |
| Remote Parquet / COG reads | DuckDB reads only the fixed Overture bucket path (release name validated by regex, values bound as parameters); GDAL reads only fixed DEM and Sentinel hosts with `CPL_VSIL_CURL_ALLOWED_EXTENSIONS`. |
| Local tile endpoint (Windows app) | `/api/v1/tiles/{set}/{z}/{x}/{y}` accepts only the three fixed tile sets and in-range integers; saved offline areas live in per-region folders named by random ids; region create/delete use the Settings guard; downloads are capped (8,000 tiles, 6°) and paced. |
| Request bodies with coordinates | Measure, profile and polygon endpoints validate counts (≤ 200 points) and ranges; polygon exposure caps the area (25° box; Overpass skipped above 5,000 km²). |
| Prompt injection (future local AI) | The assistant will only call typed read-only tools against the ATLAS store; retrieved text is data, never instructions, and there is no shell/file tool. See `AI.md`. |

## Network surface
The engine binds to `127.0.0.1:8787` by default. CORS allows only the local web origins.
Exposing the engine on a network is not recommended without a reverse proxy and auth.

## Privacy
No accounts, analytics or telemetry. Context lookups send only coordinates of an incident or
of the point you clicked or drew — weather rounded to 0.05°, climatology to 0.25°; rivers,
population rings, elevation, buildings and alerts use the coordinates as given — and never
anything about you. All logs and metrics stay in memory/on disk locally. "Since you were last here" keeps one timestamp in the browser's local storage; the
interface language and start view are stored the same way.

## Reporting
Please open a private security advisory on GitHub rather than a public issue.
