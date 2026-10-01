import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Facility } from "./api";
import type { HistoricalEvent } from "./history";
import type { HazardId } from "./hazards";

export type TimeWindow = "1h" | "24h" | "7d" | "30d";
export type View = "planet" | "board" | "gallery" | "sources" | "health";
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
  /** screen pixels hidden at the bottom (the phone sheet); the target is framed above them */
  insetBottom?: number;
  /** arrive at an oblique angle and orbit slowly until the user takes over */
  cinematic?: boolean;
}

/** imagery overlays in catalogue order (see globe/imagery.ts) */
const OVERLAY_IDS = ["imagery.truecolor", "imagery.precip", "imagery.sst", "imagery.no2", "imagery.so2", "imagery.aerosol", "imagery.lst", "imagery.flood", "imagery.water", "imagery.ndvi", "imagery.population", "imagery.relief"];

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
  | "imagery.effis-fwi"
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
  | "imagery.relief"
  | "terrain"
  | "waves"
  | "terminator"
  | "aurora"
  | "alerts"
  | "satellites"
  | "embers"
  | "minimap";

export const DEFAULT_LAYERS: Record<LayerId, boolean> = {
  waves: true,
  terminator: true,
  aurora: true,
  alerts: true,
  satellites: false,
  embers: true,
  minimap: true,
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
  "imagery.effis-fwi": false,
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
  terrain: false,
};

/** A derived raster draped on the globe (e.g. a Sentinel-2 change map). */
export interface RasterOverlay {
  incidentId: string;
  url: string;
  bbox: [number, number, number, number];
  label: string;
}

/** Earthquake shaking scenario (Simulation Lab). SIMULATION — NOT A FORECAST. */
export interface SimulationState {
  lat: number;
  lon: number;
  magnitude: number;
  depth_km: number;
  subject: string | null;
}

/** Split-screen comparison of one satellite product on two dates (Phase 3). */
export interface CompareState {
  product: string;
  /** YYYY-MM-DD shown left of the divider */
  before: string;
  /** YYYY-MM-DD shown right of the divider */
  after: string;
  /** divider position as a fraction of the globe width */
  position: number;
  /** what the comparison is about, e.g. an incident title */
  subject: string | null;
  /** a divider dragged across one globe, or two linked globes side by side */
  layout?: "swipe" | "side";
}

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
  shortcutsOpen: boolean;
  /** imagery overlay opacity (0.1–1) by overlay id; missing = the overlay's default */
  overlayOpacity: Record<string, number>;
  /** imagery overlays from bottom to top (ids); ones not listed keep their catalogue order */
  overlayOrder: string[];
  /** Shift+drag on the timeline: only incidents that began inside [from, to] (ms). */
  timeRange: [number, number] | null;
  /** Historical playback cursor (ms since epoch); null = live. */
  playhead: number | null;
  playing: boolean;
  /** simulated hours per real second */
  speed: number;
  /** Active historical replay (Demo Mode), or null for live data. */
  history: HistoricalEvent | null;
  /** terrain vertical exaggeration factor */
  exaggeration: number;
  compare: CompareState | null;
  rasterOverlay: RasterOverlay | null;
  assistantOpen: boolean;
  assistantSeed: string;
  simulation: SimulationState | null;
  story: { index: number; playing: boolean } | null;
  /** incident ids pinned for side-by-side comparison (max 3) */
  pinned: string[];
  comparingIncidents: boolean;
  /** waiting for a click on the globe to place something (the scenario epicentre) */
  groundPick: "simulation" | "watch" | null;

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
  setTimeRange: (r: [number, number] | null) => void;
  setShortcutsOpen: (open: boolean) => void;
  setOverlayOpacity: (id: string, opacity: number) => void;
  moveOverlay: (id: string, direction: 1 | -1, visible: string[]) => void;
  setPlaying: (on: boolean) => void;
  setSpeed: (hoursPerSecond: number) => void;
  goLive: () => void;
  setHistory: (ev: HistoricalEvent | null) => void;
  setExaggeration: (x: number) => void;
  setCompare: (c: CompareState | null) => void;
  patchCompare: (patch: Partial<CompareState>) => void;
  setRasterOverlay: (o: RasterOverlay | null) => void;
  openAssistant: (seed?: string) => void;
  setSimulation: (s: SimulationState | null) => void;
  setStory: (s: { index: number; playing: boolean } | null) => void;
  togglePin: (id: string) => void;
  clearPins: () => void;
  setComparingIncidents: (on: boolean) => void;
  patchSimulation: (p: Partial<SimulationState>) => void;
  setGroundPick: (p: "simulation" | "watch" | null) => void;
  closeAssistant: () => void;
}

/** Position of an overlay in the user's order (unlisted ones keep catalogue order, below listed ones). */
export function rank(order: string[], id: string): number {
  const i = order.indexOf(id);
  return i < 0 ? -1000 + OVERLAY_IDS.indexOf(id) : i;
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
      timeRange: null,
      shortcutsOpen: false,
      overlayOpacity: {},
      overlayOrder: [],
      playing: false,
      speed: 6,
      history: null,
      exaggeration: 1.5,
      compare: null,
      rasterOverlay: null,
      assistantOpen: false,
      assistantSeed: "",
      simulation: null,
      groundPick: null,
      story: null,
      pinned: [],
      comparingIncidents: false,

      setView: (view) => set({ view }),
      select: (selectedId) =>
        set((s) => ({
          selectedId,
          autoRotate: selectedId ? false : s.autoRotate,
          workspace: selectedId ? s.workspace : false,
          rasterOverlay: s.rasterOverlay && s.rasterOverlay.incidentId === selectedId ? s.rasterOverlay : null,
        })),
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
      setTimeRange: (timeRange) => set({ timeRange }),
      setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }),
      setOverlayOpacity: (id, opacity) => set((s) => ({ overlayOpacity: { ...s.overlayOpacity, [id]: Math.min(1, Math.max(0.1, opacity)) } })),
      moveOverlay: (id, direction, visible) =>
        set((s) => {
          // order the visible overlays as currently drawn, then swap with the neighbour
          const order = [...visible].sort((a, b) => rank(s.overlayOrder, a) - rank(s.overlayOrder, b));
          const i = order.indexOf(id);
          const j = i + direction;
          if (i < 0 || j < 0 || j >= order.length) return {};
          [order[i], order[j]] = [order[j]!, order[i]!];
          return { overlayOrder: [...s.overlayOrder.filter((x) => !order.includes(x)), ...order] };
        }),
      setPlaying: (playing) => set({ playing }),
      setSpeed: (speed) => set({ speed }),
      goLive: () => set({ playhead: null, playing: false, history: null }),
      setHistory: (history) => set({ history }),
      setExaggeration: (exaggeration) => set({ exaggeration }),
      setCompare: (compare) => set((s) => ({ compare, autoRotate: compare ? false : s.autoRotate, simulation: compare ? null : s.simulation })),
      setRasterOverlay: (rasterOverlay) => set({ rasterOverlay }),
      setSimulation: (simulation) =>
        set((s) => ({ simulation, groundPick: simulation ? s.groundPick : null, autoRotate: simulation ? false : s.autoRotate, compare: simulation ? null : s.compare })),
      setStory: (story) =>
        set((s) => ({ story, autoRotate: story ? false : s.autoRotate, compare: story ? null : s.compare, simulation: story ? null : s.simulation })),
      togglePin: (id) => set((s) => ({ pinned: s.pinned.includes(id) ? s.pinned.filter((x) => x !== id) : [...s.pinned, id].slice(-3) })),
      clearPins: () => set({ pinned: [], comparingIncidents: false }),
      setComparingIncidents: (comparingIncidents) => set({ comparingIncidents }),
      patchSimulation: (p) => set((s) => (s.simulation ? { simulation: { ...s.simulation, ...p } } : {})),
      setGroundPick: (groundPick) => set({ groundPick }),
      openAssistant: (seed = "") => set({ assistantOpen: true, assistantSeed: seed, paletteOpen: false }),
      closeAssistant: () => set({ assistantOpen: false, assistantSeed: "" }),
      patchCompare: (patch) => set((s) => (s.compare ? { compare: { ...s.compare, ...patch } } : {})),
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
        exaggeration: s.exaggeration,
        pinned: s.pinned,
        overlayOpacity: s.overlayOpacity,
        overlayOrder: s.overlayOrder,
      }),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<UiState>;
        return { ...current, ...p, layers: { ...DEFAULT_LAYERS, ...(p.layers ?? {}) } };
      },
    },
  ),
);
