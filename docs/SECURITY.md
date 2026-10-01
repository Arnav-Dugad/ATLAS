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
| Secrets | Only optional keys, read from environment / `.env` (gitignored). Stored as `SecretStr`; never logged or sent to the client. In the Windows app, keys entered in Settings are encrypted with DPAPI for the current Windows user (`credentials.json` in the data folder); the API returns only "set" and the last four characters. |
| A web page driving the local Settings API | Settings endpoints exist only in the Windows app, require the Host to be the loopback engine (no DNS rebinding) and any browser `Origin` to be the app's own; state changes need JSON bodies, so browsers must preflight them and CORS refuses other origins. Pack imports copy only the pack's own file types (`.tif`, `.geojson`, `.json`) from a folder holding a matching ATLAS manifest. |
| Prompt injection (future local AI) | The assistant will only call typed read-only tools against the ATLAS store; retrieved text is data, never instructions, and there is no shell/file tool. See `AI.md`. |

## Network surface
The engine binds to `127.0.0.1:8787` by default. CORS allows only the local web origins.
Exposing the engine on a network is not recommended without a reverse proxy and auth.

## Privacy
No accounts, analytics or telemetry. Weather lookups send only the incident location rounded
to 0.05°. All logs and metrics stay in memory/on disk locally.

## Reporting
Please open a private security advisory on GitHub rather than a public issue.
