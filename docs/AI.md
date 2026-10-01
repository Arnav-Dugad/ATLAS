# ATLAS Analyst — local AI (Phase 4)

ATLAS is fully capable with AI disabled; its intelligence comes from data engineering, GIS,
statistics and correlation. The **ATLAS Analyst** is an optional layer that answers
questions in plain language by calling ATLAS's own read-only tools, on your machine.

## Principles

1. **Local only.** The engine talks to an [Ollama](https://ollama.com) server on the same
   computer; the base URL must be a loopback address (`ATLAS_AI_BASE_URL`, default
   `http://127.0.0.1:11434`). Questions, tool results and answers never leave the device.
   There is no cloud inference and no API key.
2. **Tools, not memory.** The system prompt forbids stating figures from the model's own
   weights. Facts come from typed tools; every incident mentioned must be cited by id.
3. **Every claim is linked.** The answer stream ends with citations: incidents returned by
   tools and mentioned in the answer (clickable, they fly the globe there), the data sources
   behind them, and documentation sections used. Ids that appear in an answer but were never
   returned by a tool are flagged **unverified**.
4. **Injection-resistant by construction** (see below).

## Tools

| Tool | Reads | Bounds |
|---|---|---|
| `search_incidents` | incident store | hazard enum, status, severity 0–5, country (resolved offline), title words ≤ 80 chars, ≤ 60 days, ≤ 20 results |
| `get_incident` | incident store | id must match `ATL-XX-YYYY-XXXXXXXX` |
| `population_exposure` | GHSL Population Pack | id as above; "model estimate, not people affected" |
| `planet_overview` | incident store | — |
| `recent_changes` | audit trail | ≤ 72 h, ≤ 20 rows |
| `earthquake_archive` | USGS ComCat (FDSN) | M 4.0–9.5, ≤ 60 years, ≤ 25 rows |
| `search_docs` | `docs/*.md` (BM25, no embedding model) | query ≤ 120 chars, top 3 sections |
| `source_status` | Data Source Registry | — |

Arguments are validated with strict Pydantic models (unknown fields rejected). Invalid calls
return an error the model can read; they never raise.

## Prompt-injection defences

Feed text (titles, report summaries) is untrusted and may contain instructions. In depth:

1. **Capability.** There is no tool that writes, deletes, executes, fetches arbitrary URLs or
   reads files. An injected "call `delete_everything`" fails with *Unknown tool*; a test
   asserts the store is unchanged afterwards.
2. **Isolation.** Every tool result is wrapped as `UNTRUSTED DATA … <data>…</data>` and feed
   strings are normalised (NFKC), stripped of control and bidi characters and truncated.
3. **Budget.** At most 4 tool rounds and 3 calls per round; the final round has no tools.
4. **Rendering.** The browser renders answers with a minimal markdown renderer that builds
   React elements only — no HTML — and shows links as text.
5. **Concurrency.** One question at a time per machine.

## Streaming protocol

`POST /api/v1/ai/ask {question, history?, model?}` returns Server-Sent Events:
`status`, `tool_call`, `tool_result`, `token`, `reset` (text before a tool call was thinking
aloud), `citations`, `done`, `error`. `GET /api/v1/ai/status` reports Ollama, installed
models and whether each supports tool calling. Reasoning blocks (`<think>…</think>`) are
removed from the stream.

## Models and hardware

Any installed Ollama model that reports the `tools` capability works. Preference order:
`qwen3:8b`, `qwen2.5:7b`, `llama3.1:8b`, `qwen3:4b`, `mistral-nemo`, `llama3.2:3b`,
`qwen2.5:3b` (override with `ATLAS_AI_MODEL`). On an RTX 4060 laptop (8 GB VRAM) a 7–8B
model at Q4_K_M answers in a few seconds per round; 3–4B models run on CPU-only machines.

```bash
# one-time
winget install Ollama.Ollama        # or https://ollama.com/download
ollama pull qwen2.5:7b              # ≈ 4.7 GB
# then open ATLAS → Ask (or press A)
```

## Testing

`services/engine/tests/test_ai.py` runs the full agent loop against a protocol-faithful fake
Ollama (`/api/version`, `/api/tags`, `/api/show`, streamed `/api/chat`): tool validation,
citations, budget enforcement, hidden reasoning, unavailable states and injection
containment. The public snapshot does not include the assistant (it needs a local model).
