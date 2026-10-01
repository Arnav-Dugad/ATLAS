import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Facility } from "./api";
import type { HazardId } from "./hazards";

export type TimeWindow = "1h" | "24h" | "7d" | "30d";
export type View = "planet" | "sources" | "health";
export type StatusFilter = "active" | "open" | "all";

export const WINDOW_HOURS: Record<TimeWindow, number> = { "1h": 1, "24h": 24, "7d": 24 * 7, "30d": 24 * 30 };

export interface FlyRequest {
  id: number;
  lat: number;
  lon: number;
  /** camera height in metres */
  height: number;
  /** optional bounding box [w, s, e, n] to frame instead of a point */
  bbox?: [number, number, number, number] | null;
  duration?: number;
}

export type LayerId =
  | "incidents"
  | "earthquakes"
  | "fires"
  | "fireClusters"
  | "cyclones"
  | "borders"
  | "labels"
  | "nightLights"
  | "lighting"
  | "imagery.truecolor"
  | "imagery.precip"
  | "imagery.sst"
  | "imagery.no2"
  | "imagery.so2"
  | "imagery.aerosol"
  | "imagery.lst"
  | "imagery.flood"
  | "imagery.water"
  | "imagery.ndvi"
  | "imagery.population"
  | "imagery.relief";

export const DEFAULT_LAYERS: Record<LayerId, boolean> = {
  incidents: true,
  earthquakes: true,
  fires: true,
  fireClusters: true,
  cyclones: true,
  borders: true,
  labels: false,
  nightLights: true,
  lighting: true,
  "imagery.truecolor": false,
  "imagery.precip": false,
  "imagery.sst": false,
  "imagery.no2": false,
  "imagery.so2": false,
  "imagery.aerosol": false,
  "imagery.lst": false,
  "imagery.flood": false,
  "imagery.water": false,
  "imagery.ndvi": false,
  "imagery.population": false,
  "imagery.relief": false,
};

interface UiState {
  view: View;
  selectedId: string | null;
  hoveredId: string | null;
  hazards: HazardId[];
  status: StatusFilter;
  minSeverity: number;
  sort: "severity" | "recent";
  query: string;
  window: TimeWindow;
  layers: Record<LayerId, boolean>;
  imageryDate: string;
  paletteOpen: boolean;
  paletteSeed: string;
  layersOpen: boolean;
  introSeen: boolean;
  reducedMotion: boolean;
  highContrast: boolean;
  autoRotate: boolean;
  fly: FlyRequest | null;
  workspace: boolean;
  facilities: Facility[];
  /** Historical playback cursor (ms since epoch); null = live. */
  playhead: number | null;
  playing: boolean;
  /** simulated hours per real second */
  speed: number;

  setView: (v: View) => void;
  select: (id: string | null, opts?: { fly?: boolean }) => void;
  hover: (id: string | null) => void;
  toggleHazard: (h: HazardId) => void;
  setHazards: (h: HazardId[]) => void;
  setStatus: (s: StatusFilter) => void;
  setMinSeverity: (n: number) => void;
  setSort: (s: "severity" | "recent") => void;
  setQuery: (q: string) => void;
  setWindow: (w: TimeWindow) => void;
  toggleLayer: (id: LayerId, on?: boolean) => void;
  setImageryDate: (d: string) => void;
  openPalette: (seed?: string) => void;
  closePalette: () => void;
  setLayersOpen: (open: boolean) => void;
  dismissIntro: () => void;
  resetIntro: () => void;
  setReducedMotion: (on: boolean) => void;
  setHighContrast: (on: boolean) => void;
  setAutoRotate: (on: boolean) => void;
  flyTo: (req: Omit<FlyRequest, "id">) => void;
  setWorkspace: (on: boolean) => void;
  setFacilities: (f: Facility[]) => void;
  setPlayhead: (t: number | null) => void;
  setPlaying: (on: boolean) => void;
  setSpeed: (hoursPerSecond: number) => void;
  goLive: () => void;
}

function yesterdayUtc(): string {
  const d = new Date(Date.now() - 24 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

let flySeq = 0;

export const useUi = create<UiState>()(
  persist(
    (set) => ({
      view: "planet",
      selectedId: null,
      hoveredId: null,
      hazards: [],
      status: "open",
      minSeverity: 0,
      sort: "severity",
      query: "",
      window: "7d",
      layers: DEFAULT_LAYERS,
      imageryDate: yesterdayUtc(),
      paletteOpen: false,
      paletteSeed: "",
      layersOpen: false,
      introSeen: false,
      reducedMotion: typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
      highContrast: false,
      autoRotate: true,
      fly: null,
      workspace: false,
      facilities: [],
      playhead: null,
      playing: false,
      speed: 6,

      setView: (view) => set({ view }),
      select: (selectedId) => set((s) => ({ selectedId, autoRotate: selectedId ? false : s.autoRotate, workspace: selectedId ? s.workspace : false })),
      hover: (hoveredId) => set({ hoveredId }),
      toggleHazard: (h) =>
        set((s) => ({ hazards: s.hazards.includes(h) ? s.hazards.filter((x) => x !== h) : [...s.hazards, h] })),
      setHazards: (hazards) => set({ hazards }),
      setStatus: (status) => set({ status }),
      setMinSeverity: (minSeverity) => set({ minSeverity }),
      setSort: (sort) => set({ sort }),
      setQuery: (query) => set({ query }),
      setWindow: (window) => set({ window }),
      toggleLayer: (id, on) => set((s) => ({ layers: { ...s.layers, [id]: on ?? !s.layers[id] } })),
      setImageryDate: (imageryDate) => set({ imageryDate }),
      openPalette: (seed = "") => set({ paletteOpen: true, paletteSeed: seed }),
      closePalette: () => set({ paletteOpen: false, paletteSeed: "" }),
      setLayersOpen: (layersOpen) => set({ layersOpen }),
      dismissIntro: () => set({ introSeen: true }),
      resetIntro: () => set({ introSeen: false }),
      setReducedMotion: (reducedMotion) => set({ reducedMotion }),
      setHighContrast: (highContrast) => set({ highContrast }),
      setAutoRotate: (autoRotate) => set({ autoRotate }),
      flyTo: (req) => set({ fly: { ...req, id: ++flySeq }, autoRotate: false }),
      setWorkspace: (workspace) => set({ workspace }),
      setFacilities: (facilities) => set({ facilities }),
      setPlayhead: (playhead) => set({ playhead, autoRotate: false }),
      setPlaying: (playing) => set({ playing }),
      setSpeed: (speed) => set({ speed }),
      goLive: () => set({ playhead: null, playing: false }),
    }),
    {
      name: "atlas.ui.v1",
      partialize: (s) => ({
        layers: s.layers,
        window: s.window,
        introSeen: s.introSeen,
        reducedMotion: s.reducedMotion,
        highContrast: s.highContrast,
        hazards: s.hazards,
        status: s.status,
        sort: s.sort,
        speed: s.speed,
      }),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<UiState>;
        return { ...current, ...p, layers: { ...DEFAULT_LAYERS, ...(p.layers ?? {}) } };
      },
    },
  ),
);
