/**
 * Large map layers (fire grid, fire detections, earthquakes) are fetched and parsed in a worker,
 * so the globe and the panels never stall on a multi-megabyte JSON.parse. Falls back to a normal
 * fetch where workers are unavailable.
 */
export const LAYER_PATH = /^\/api\/v1\/layers\/(earthquakes|fires\/grid|fires\/detections)$/;

type Reply = { id: number; ok: boolean; status: number; data?: unknown; type?: string; text?: string; error?: string };

let worker: Worker | null | undefined;
let seq = 0;
const pending = new Map<number, (r: Reply) => void>();

function getWorker(): Worker | null {
  if (worker !== undefined) return worker;
  try {
    worker = new Worker(new URL("./layer.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<Reply>) => {
      pending.get(e.data.id)?.(e.data);
      pending.delete(e.data.id);
    };
    worker.onerror = () => {
      for (const [, done] of pending) done({ id: -1, ok: false, status: 0, error: "worker failed" });
      pending.clear();
      worker = null; // fall back to the main thread from now on
    };
  } catch {
    worker = null;
  }
  return worker;
}

export interface LayerResponse {
  ok: boolean;
  status: number;
  data?: unknown;
  /** non-JSON or error body, for the caller's error handling */
  text?: string;
  type?: string;
  networkError?: string;
}

export async function fetchLayer(url: string, headers: Record<string, string>, signal?: AbortSignal): Promise<LayerResponse> {
  const w = getWorker();
  if (!w) {
    const res = await fetch(url, { headers, signal });
    const type = res.headers.get("content-type") ?? "";
    if (!res.ok || !type.includes("json")) return { ok: false, status: res.status, type, text: await res.text() };
    return { ok: true, status: res.status, data: await res.json() };
  }
  const id = ++seq;
  return new Promise<LayerResponse>((resolve, reject) => {
    const onAbort = () => {
      w.postMessage({ id, abort: true });
      pending.delete(id);
      reject(new DOMException("Aborted", "AbortError"));
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
    pending.set(id, (r) => {
      signal?.removeEventListener("abort", onAbort);
      if (r.error === "abort") return reject(new DOMException("Aborted", "AbortError"));
      if (r.error) return resolve({ ok: false, status: 0, networkError: r.error });
      resolve({ ok: r.ok, status: r.status, data: r.data, text: r.text, type: r.type });
    });
    w.postMessage({ id, url: new URL(url, location.href).toString(), headers });
  });
}
