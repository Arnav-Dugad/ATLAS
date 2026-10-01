# ATLAS AI (planned — Phase 4)

ATLAS must be fully capable with AI disabled; its intelligence comes from data engineering,
GIS, statistics and correlation. The assistant is an optional layer on top.

## Principles

1. **Local only.** Ollama or llama.cpp on the user's machine. No cloud inference, ever.
2. **Tools, not memory.** The model never states coordinates, magnitudes, populations or
   casualties from its own weights. It calls typed, read-only ATLAS tools and cites results.
3. **Every claim is linked.** Answers carry citations to incident ids, observations and
   source registry entries; uncited sentences are rendered as commentary.
4. **Injection-resistant.** Retrieved text (reports, descriptions) is wrapped as data. The
   assistant has no shell, file or network tools; tool arguments are schema-validated.

## Planned tool surface

| Tool | Backed by |
|---|---|
| `search_incidents(filters)` | `/api/v1/incidents` + query parser |
| `get_incident(id)` | `/api/v1/incidents/{id}` |
| `knowledge_at(id, time)` | Data Time Machine endpoint |
| `earthquake_archive(bbox, start, end, min_mag)` | USGS FDSN connector |
| `nearby_places(lat, lon, k)` | offline geocoder |
| `weather(id)` | Open-Meteo context |
| `explain_metric(key)` | `docs/METHODOLOGY.md` sections (local embeddings) |

## Hardware targets
RTX 4060 laptop (8 GB VRAM): 7–8B instruction models at Q4_K_M (e.g. Llama 3.1 8B,
Qwen2.5 7B) for tool use; a small local embedding model for documentation RAG; CPU fallback
with smaller models. Performance profiles: Eco / Balanced / Performance / Auto.
