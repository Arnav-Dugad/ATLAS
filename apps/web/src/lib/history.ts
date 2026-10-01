/**
 * Demo Mode: curated, cached *real* historical earthquake sequences (USGS ComCat).
 * Built by `pnpm engine demo build`; shipped as a static asset so presentations work offline.
 */
import { useQuery } from "@tanstack/react-query";
import { useUi } from "./store";

export interface HistoricalEvent {
  id: string;
  name: string;
  title: string;
  time: string;
  lat: number;
  lon: number;
  depth_km: number | null;
  magnitude: number;
  mag_type: string | null;
  pager_alert: string | null;
  tsunami_flag: boolean;
  felt: number | null;
  mmi: number | null;
  url: string | null;
  sequence: { count: number; window: string; columns: { t: number[]; lat: number[]; lon: number[]; depth: (number | null)[]; mag: number[] } };
}

export interface HistoricalCatalog {
  generated_at: string;
  source: string;
  attribution: string;
  license: string;
  note: string;
  events: HistoricalEvent[];
}

export function useHistoricalCatalog(enabled = true) {
  return useQuery({
    queryKey: ["historical-catalog"],
    queryFn: async ({ signal }) => {
      const res = await fetch(`${import.meta.env.BASE_URL}demo/historical-earthquakes.json`, { signal });
      if (!res.ok) throw new Error(`Historical catalogue unavailable (${res.status})`);
      return (await res.json()) as HistoricalCatalog;
    },
    enabled,
    staleTime: Infinity,
  });
}

export const HISTORY_BEFORE_MS = 2 * 3600_000;
export const HISTORY_AFTER_MS = 7 * 24 * 3600_000;

/** Enter replay of a historical sequence: fly there, set the window, start playing. */
export function startHistoricalReplay(ev: HistoricalEvent) {
  const ui = useUi.getState();
  const t0 = Date.parse(ev.time);
  ui.select(null);
  ui.setHistory(ev);
  ui.setPlayhead(t0 - HISTORY_BEFORE_MS / 2);
  ui.setSpeed(6);
  ui.flyTo({ lat: ev.lat, lon: ev.lon, height: 2_600_000 });
  setTimeout(() => useUi.getState().setPlaying(true), 1800);
}
