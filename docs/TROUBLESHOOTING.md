# Troubleshooting

**The globe is blank / "3D globe unavailable".** Enable hardware acceleration in your
browser (Chrome: Settings → System). ATLAS needs WebGL2. Data views keep working.

**"Engine offline" in the top bar.** Start the engine (`pnpm dev` or `pnpm engine serve`).
The web client retries the live stream with exponential backoff.

**`IO Error: Cannot open file … atlas.duckdb … used by another process`.** DuckDB allows one
writer process. Stop the running engine before using CLI commands like `atlas sync`, or
query through the API.

**Setup fails installing DuckDB extensions.** The `spatial` and `h3` extensions download
once from `extensions.duckdb.org` and are cached; run `pnpm engine setup` again with network
access. Fire indexing requires `h3`.

**A source shows "degraded" or "error".** Open Sources → the source card for the last error
and sync history. ATLAS serves the last good cached response (`stale`) during outages.

**ReliefWeb / OpenAQ show "disabled".** They require a free approved appname / API key;
see `.env.example`.

**Windows console shows garbled characters.** Use the provided scripts (`pnpm dev`,
`pnpm engine …`) which set UTF-8 output, or set `PYTHONUTF8=1`.

**Typecheck fails after changing the API.** Regenerate client types: `pnpm gen:api`.
