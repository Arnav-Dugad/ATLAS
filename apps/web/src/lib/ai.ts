/**
 * Local AI (Phase 4): the engine streams an answer from an Ollama model running on this
 * computer. The request is a POST, so Server-Sent Events are parsed from a fetch stream.
 */
import { API_BASE, ApiError, STATIC_MODE } from "./api";

export interface AiModel {
  name: string;
  tools: boolean | null;
  size_bytes: number | null;
  family: string | null;
  parameters: string | null;
  quantization: string | null;
}

export interface AiStatus {
  available: boolean;
  reason: string | null;
  ollama_version?: string;
  base_url: string;
  model?: string | null;
  recommended_model: string;
  models: AiModel[];
  tools?: string[];
}

export type AiEvent =
  | { event: "status"; data: { model: string } }
  | { event: "tool_call"; data: { name: string; args: Record<string, unknown> } }
  | { event: "tool_result"; data: { name: string; summary: string; ok: boolean } }
  | { event: "token"; data: { text: string } }
  | { event: "reset"; data: Record<string, never> }
  | {
      event: "citations";
      data: {
        incidents: { id: string; title: string; hazard: string | null; lat: number | null; lon: number | null }[];
        sources: string[];
        docs: { doc: string; section: string }[];
        unverified_ids: string[];
      };
    }
  | { event: "done"; data: { model: string; rounds: number; tool_calls: number; elapsed_s: number } }
  | { event: "error"; data: { code: string; message: string } };

export interface AiTurn {
  role: "user" | "assistant";
  content: string;
}

export async function aiStatus(signal?: AbortSignal): Promise<AiStatus> {
  if (STATIC_MODE) throw new ApiError(501, "local_only", "The assistant runs on your own computer.");
  const res = await fetch(`${API_BASE}/api/v1/ai/status`, { signal, headers: { Accept: "application/json" } }).catch((err: Error) => {
    if (err.name === "AbortError") throw err;
    throw new ApiError(0, "offline", "The ATLAS engine is not reachable.");
  });
  if (!res.ok) throw new ApiError(res.status, "http_error", `Assistant status failed (${res.status})`);
  return (await res.json()) as AiStatus;
}

/** Parse one SSE block ("event: x\ndata: y") into an event, or null for pings/comments. */
export function parseSseBlock(block: string): AiEvent | null {
  let event = "message";
  const data: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  }
  if (!data.length || event === "ping" || event === "message") return null;
  try {
    return { event, data: JSON.parse(data.join("\n")) } as AiEvent;
  } catch {
    return null;
  }
}

export async function askStream(
  question: string,
  history: AiTurn[],
  onEvent: (e: AiEvent) => void,
  opts: { model?: string | null; signal?: AbortSignal } = {},
): Promise<void> {
  const res = await fetch(`${API_BASE}/api/v1/ai/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({ question, history: history.slice(-8), model: opts.model ?? null }),
    signal: opts.signal,
  });
  if (!res.ok || !res.body) throw new ApiError(res.status, "http_error", `The assistant request failed (${res.status}).`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let cut: number;
    while ((cut = buf.search(/\r?\n\r?\n/)) >= 0) {
      const block = buf.slice(0, cut);
      buf = buf.slice(cut).replace(/^\r?\n\r?\n/, "");
      const ev = parseSseBlock(block);
      if (ev) onEvent(ev);
    }
  }
  const tail = parseSseBlock(buf);
  if (tail) onEvent(tail);
}
