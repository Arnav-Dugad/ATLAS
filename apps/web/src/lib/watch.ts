/**
 * Watchlists (Phase 5): areas a person cares about. Stored only in this browser; matching runs
 * on the incidents ATLAS already has; alerts use the browser's own Notification API — no
 * account, no server, nothing leaves the device.
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { IncidentSummary } from "./api";
import type { HazardId } from "./hazards";

export interface Watch {
  id: string;
  name: string;
  lat: number;
  lon: number;
  radius_km: number;
  hazards: HazardId[]; // empty = all hazards
  minSeverity: number;
  notify: boolean;
  createdAt: number;
}

interface WatchState {
  watches: Watch[];
  /** incident ids already seen per watch (so alerts fire once, and never for the backlog) */
  seen: Record<string, string[]>;
  panelOpen: boolean;
  draft: { lat: number; lon: number } | null;
  add: (w: Omit<Watch, "id" | "createdAt">) => void;
  update: (id: string, patch: Partial<Watch>) => void;
  remove: (id: string) => void;
  markSeen: (id: string, ids: string[]) => void;
  setPanelOpen: (open: boolean) => void;
  setDraft: (d: { lat: number; lon: number } | null) => void;
}

export const useWatch = create<WatchState>()(
  persist(
    (set) => ({
      watches: [],
      seen: {},
      panelOpen: false,
      draft: null,
      add: (w) => set((s) => ({ watches: [...s.watches, { ...w, id: `w${Date.now().toString(36)}`, createdAt: Date.now() }].slice(-20) })),
      update: (id, patch) => set((s) => ({ watches: s.watches.map((w) => (w.id === id ? { ...w, ...patch } : w)) })),
      remove: (id) =>
        set((s) => {
          const seen = { ...s.seen };
          delete seen[id];
          return { watches: s.watches.filter((w) => w.id !== id), seen };
        }),
      markSeen: (id, ids) => set((s) => ({ seen: { ...s.seen, [id]: [...new Set([...(s.seen[id] ?? []), ...ids])].slice(-2000) } })),
      setPanelOpen: (panelOpen) => set({ panelOpen }),
      setDraft: (draft) => set({ draft, panelOpen: true }),
    }),
    { name: "atlas.watch.v1", partialize: (s) => ({ watches: s.watches, seen: s.seen }) },
  ),
);

export function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Open incidents inside a watch area that pass its filters, nearest first. */
export function matches(w: Watch, incidents: IncidentSummary[]): (IncidentSummary & { distance_km: number })[] {
  const out: (IncidentSummary & { distance_km: number })[] = [];
  for (const inc of incidents) {
    if (inc.lat == null || inc.lon == null || inc.status === "closed") continue;
    if (w.hazards.length && !w.hazards.includes(inc.hazard as HazardId)) continue;
    if (inc.severity.level < w.minSeverity) continue;
    const d = distanceKm(w.lat, w.lon, inc.lat, inc.lon);
    if (d <= w.radius_km) out.push({ ...inc, distance_km: d });
  }
  return out.sort((a, b) => a.distance_km - b.distance_km);
}
