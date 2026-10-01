/// <reference lib="webworker" />
/**
 * Fetches and parses large map-layer responses off the main thread. Columns that are entirely
 * numbers (no nulls, no strings) come back as Float64Arrays whose buffers are transferred, not
 * copied; every other column stays a plain array, so readers see exactly the same values.
 */
interface Req {
  id: number;
  url: string;
  headers: Record<string, string>;
}

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const controllers = new Map<number, AbortController>();

ctx.onmessage = async (e: MessageEvent<Req | { id: number; abort: true }>) => {
  const msg = e.data;
  if ("abort" in msg) {
    controllers.get(msg.id)?.abort();
    return;
  }
  const ac = new AbortController();
  controllers.set(msg.id, ac);
  try {
    const res = await fetch(msg.url, { headers: msg.headers, signal: ac.signal });
    const status = res.status;
    const type = res.headers.get("content-type") ?? "";
    const text = await res.text();
    if (!res.ok || !type.includes("json")) {
      ctx.postMessage({ id: msg.id, ok: false, status, type, text: text.slice(0, 4000) });
      return;
    }
    const data = JSON.parse(text) as { columns?: Record<string, unknown[]> };
    const transfer: ArrayBuffer[] = [];
    if (data && typeof data === "object" && data.columns && typeof data.columns === "object") {
      for (const [k, col] of Object.entries(data.columns)) {
        if (Array.isArray(col) && col.length > 256 && col.every((v) => typeof v === "number")) {
          const arr = Float64Array.from(col as number[]);
          (data.columns as Record<string, unknown>)[k] = arr;
          transfer.push(arr.buffer);
        }
      }
    }
    ctx.postMessage({ id: msg.id, ok: true, status, data }, transfer);
  } catch (err) {
    ctx.postMessage({ id: msg.id, ok: false, status: 0, error: (err as Error).name === "AbortError" ? "abort" : String(err) });
  } finally {
    controllers.delete(msg.id);
  }
};
