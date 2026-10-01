/**
 * Settings of the Windows desktop app (see WINDOWS_APP): panel style and graphics quality,
 * kept in this app's own storage. Keys and data packs live in the engine (api.settings).
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { gpuInfo } from "./media";

/** Solid panels are opaque and easy to read; glass lets the planet show through (and costs GPU time). */
export type Surface = "solid" | "glass";
export type Quality = "saver" | "balanced" | "high";
/** "auto" picks from the graphics processor: High on a dedicated GPU, Battery saver on integrated graphics. */
export type QualityChoice = "auto" | Quality;
export type SettingsSection = "sources" | "packs" | "appearance" | "graphics" | "app" | "about";
export type Density = "comfortable" | "compact";
export type Accent = "atlas" | "aurora" | "solar" | "nebula" | "ember";

export interface Units {
  distance: "km" | "mi";
  temperature: "C" | "F";
  wind: "kt" | "kmh" | "mph";
}
export const DEFAULT_UNITS: Units = { distance: "km", temperature: "C", wind: "kt" };

/** Accent colours: [accent, strong, soft background, line]. */
export const ACCENTS: Record<Accent, { label: string; colors: [string, string, string, string] }> = {
  atlas: { label: "Atlas blue", colors: ["#9cc9ff", "#c4e0ff", "rgba(156, 201, 255, 0.12)", "rgba(156, 201, 255, 0.38)"] },
  aurora: { label: "Aurora green", colors: ["#7ee2b8", "#b6f2d7", "rgba(126, 226, 184, 0.12)", "rgba(126, 226, 184, 0.38)"] },
  solar: { label: "Solar amber", colors: ["#f5c26b", "#fadfa8", "rgba(245, 194, 107, 0.12)", "rgba(245, 194, 107, 0.38)"] },
  nebula: { label: "Nebula violet", colors: ["#b9a4ff", "#d8ccff", "rgba(185, 164, 255, 0.12)", "rgba(185, 164, 255, 0.38)"] },
  ember: { label: "Ember coral", colors: ["#ff9f8a", "#ffc7bb", "rgba(255, 159, 138, 0.12)", "rgba(255, 159, 138, 0.38)"] },
};

export interface QualityProfile {
  label: string;
  hint: string;
  /** drawing-buffer pixels per CSS pixel, before the device pixel ratio is applied */
  maxPixelRatio: number;
  msaa: 1 | 2 | 4;
  fxaa: boolean;
  fps: number;
  /** tile detail: larger = coarser = faster */
  screenSpaceError: number;
}

export const QUALITY: Record<Quality, QualityProfile> = {
  saver: {
    label: "Battery saver",
    hint: "30 fps, one pixel per screen point, coarser map tiles. Smoothest on integrated graphics and on battery.",
    maxPixelRatio: 1,
    msaa: 1,
    fxaa: true,
    fps: 30,
    screenSpaceError: 2.6,
  },
  balanced: {
    label: "Balanced",
    hint: "60 fps, one pixel per screen point with smoothing, medium map detail.",
    maxPixelRatio: 1,
    msaa: 1,
    fxaa: true,
    fps: 60,
    screenSpaceError: 2,
  },
  high: {
    label: "High",
    hint: "Full screen resolution (up to 2×), 4× anti-aliasing and the finest tiles. Best with a dedicated GPU.",
    maxPixelRatio: 2,
    msaa: 4,
    fxaa: true,
    fps: 60,
    screenSpaceError: 1.6,
  },
};

/** Integrated graphics (shared memory): Intel UHD/Iris/Arc iGPUs and AMD "Radeon Graphics" APUs. */
export function isIntegratedGpu(renderer: string): boolean {
  return /intel|radeon\(tm\) graphics|radeon graphics|vega \d+ graphics/i.test(renderer) && !/nvidia|geforce|quadro|radeon rx|radeon pro|arc(\(tm\))? a\d/i.test(renderer);
}

export function resolveQuality(choice: QualityChoice): Quality {
  if (choice !== "auto") return choice;
  const gpu = gpuInfo();
  return gpu.software || isIntegratedGpu(gpu.renderer) ? "saver" : "high";
}

interface SettingsState {
  surface: Surface;
  quality: QualityChoice;
  density: Density;
  accent: Accent;
  units: Units;
  setDensity: (d: Density) => void;
  setAccent: (a: Accent) => void;
  setUnits: (u: Partial<Units>) => void;
  open: boolean;
  section: SettingsSection;
  openSettings: (section?: SettingsSection) => void;
  closeSettings: () => void;
  setSurface: (s: Surface) => void;
  setQuality: (q: QualityChoice) => void;
}

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      surface: "solid",
      quality: "auto",
      density: "comfortable",
      accent: "atlas",
      units: DEFAULT_UNITS,
      setDensity: (density) => set({ density }),
      setAccent: (accent) => set({ accent }),
      setUnits: (u) => set((s) => ({ units: { ...s.units, ...u } })),
      open: false,
      section: "sources",
      openSettings: (section) => set((s) => ({ open: true, section: section ?? s.section })),
      closeSettings: () => set({ open: false }),
      setSurface: (surface) => set({ surface }),
      setQuality: (quality) => set({ quality }),
    }),
    {
      name: "atlas.settings.v1",
      partialize: (s) => ({ surface: s.surface, quality: s.quality, density: s.density, accent: s.accent, units: s.units }),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<SettingsState>;
        return { ...current, ...p, units: { ...DEFAULT_UNITS, ...(p.units ?? {}) } };
      },
    },
  ),
);

/** Subscribe a component to unit changes (values are converted where they are formatted). */
export function useUnits(): Units {
  return useSettings((s) => s.units);
}

export function openSettings(section?: SettingsSection): void {
  useSettings.getState().openSettings(section);
}
