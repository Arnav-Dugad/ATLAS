/**
 * Live connection to the engine's Server-Sent Events stream.
 * Events invalidate the relevant React Query caches (debounced) and feed the change ticker.
 */
import type { QueryClient } from "@tanstack/react-query";
import { create } from "zustand";
import { STATIC_MODE, streamUrl } from "./api";

export type LiveStatus = "connecting" | "live" | "offline" | "snapshot";

export interface LiveChange {
  id: number;
  incident_id: string;
  at: string;
  kind: string;
  summary: string;
  significance: number;
  source: string | null;
}

export interface SyncEvent {
  source: string;
  job: string;
  status: string;
  at: string;
  message: string | null;
  incidents_created?: number;
  incidents_updated?: number;
}

interface LiveState {
  status: LiveStatus;
  lastEventAt: number | null;
  lastSync: Record<string, SyncEvent>;
  changes: LiveChange[];
  created: string[];
  pushChange: (c: LiveChange) => void;
  pushCreated: (id: string) => void;
  dismiss: (id: number) => void;
}

export const useLive = create<LiveState>((set) => ({
  status: "connecting",
  lastEventAt: null,
  lastSync: {},
  changes: [],
  created: [],
  pushChange: (c) => set((s) => ({ changes: [c, ...s.changes.filter((x) => x.id !== c.id)].slice(0, 50) })),
  pushCreated: (id) => set((s) => ({ created: [id, ...s.created].slice(0, 100) })),
  dismiss: (id) => set((s) => ({ changes: s.changes.filter((c) => c.id !== id) })),
}));

export function connectLive(client: QueryClient): () => void {
  if (STATIC_MODE) {
    // The public snapshot has no stream; it is rebuilt on a schedule instead.
    useLive.setState({ status: "snapshot" });
    return () => undefined;
  }
  let es: EventSource | null = null;
  let retry = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  const pending = new Set<string>();
  let flush: ReturnType<typeof setTimeout> | null = null;

  const invalidate = (...keys: string[]) => {
    keys.forEach((k) => pending.add(k));
    if (flush) return;
    flush = setTimeout(() => {
      flush = null;
      for (const k of pending) {
        if (k.startsWith("incident:")) {
          void client.invalidateQueries({ queryKey: ["incident", k.slice(9)] });
        } else if (k === "layers.earthquakes") {
          void client.invalidateQueries({ queryKey: ["layer", "earthquakes"] });
        } else if (k === "layers.fires") {
          void client.invalidateQueries({ queryKey: ["layer"], predicate: (q) => String(q.queryKey[1]).startsWith("fire") });
        } else {
          void client.invalidateQueries({ queryKey: [k] });
        }
      }
      pending.clear();
    }, 1200);
  };

  const touch = () => useLive.setState({ status: "live", lastEventAt: Date.now() });

  const open = () => {
    if (closed) return;
    useLive.setState({ status: retry ? "offline" : "connecting" });
    es = new EventSource(streamUrl());
    es.addEventListener("hello", () => {
      retry = 0;
      touch();
    });
    es.addEventListener("ping", touch);
    const onIncident = (ev: MessageEvent<string>) => {
      touch();
      try {
        const msg = JSON.parse(ev.data) as { kind: string; data: { id: string } };
        if (msg.kind === "incident.created") useLive.getState().pushCreated(msg.data.id);
        invalidate("incidents", "overview", `incident:${msg.data.id}`);
      } catch {
        /* ignore malformed */
      }
    };
    es.addEventListener("incident.created", onIncident);
    es.addEventListener("incident.updated", onIncident);
    es.addEventListener("incident.change", (ev: MessageEvent<string>) => {
      touch();
      try {
        const msg = JSON.parse(ev.data) as { data: LiveChange };
        useLive.getState().pushChange(msg.data);
        invalidate("changes", `incident:${msg.data.incident_id}`);
      } catch {
        /* ignore malformed */
      }
    });
    es.addEventListener("source.synced", (ev: MessageEvent<string>) => {
      touch();
      try {
        const msg = JSON.parse(ev.data) as { data: SyncEvent };
        useLive.setState((s) => ({ lastSync: { ...s.lastSync, [msg.data.source]: msg.data } }));
        invalidate("sources", "overview");
        if (msg.data.source === "usgs") invalidate("layers.earthquakes");
        if (msg.data.source === "firms") invalidate("layers.fires");
      } catch {
        /* ignore malformed */
      }
    });
    es.onerror = () => {
      es?.close();
      es = null;
      useLive.setState({ status: "offline" });
      retry += 1;
      const delay = Math.min(30_000, 1000 * 2 ** Math.min(retry, 5));
      timer = setTimeout(open, delay);
    };
  };

  open();
  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    if (flush) clearTimeout(flush);
    es?.close();
  };
}
