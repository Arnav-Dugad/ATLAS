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
      open: false,
      section: "sources",
      openSettings: (section) => set((s) => ({ open: true, section: section ?? s.section })),
      closeSettings: () => set({ open: false }),
      setSurface: (surface) => set({ surface }),
      setQuality: (quality) => set({ quality }),
    }),
    { name: "atlas.settings.v1", partialize: (s) => ({ surface: s.surface, quality: s.quality }) },
  ),
);

export function openSettings(section?: SettingsSection): void {
  useSettings.getState().openSettings(section);
}
