/**
 * Hazard taxonomy for the interface. Every hazard has a colour AND a unique glyph so that
 * meaning never depends on colour alone (WCAG 1.4.1). Glyph paths are 24×24 line drawings
 * shared by the DOM icons and the WebGL billboard sprites.
 */

export type HazardId =
  | "earthquake"
  | "tropical_cyclone"
  | "wildfire"
  | "flood"
  | "volcano"
  | "drought"
  | "severe_storm"
  | "tsunami"
  | "landslide"
  | "extreme_heat"
  | "extreme_cold"
  | "air_quality"
  | "sea_lake_ice"
  | "dust_haze"
  | "other";

export interface HazardMeta {
  id: HazardId;
  label: string;
  plural: string;
  short: string;
  color: string;
  glyph: string;
}

const G = {
  earthquake:
    "M12 10a2 2 0 1 0 0.001 4z M12 10a2 2 0 1 1 0.001 4z M8.4 8.4a5.1 5.1 0 0 0 0 7.2 M15.6 8.4a5.1 5.1 0 0 1 0 7.2 M5.5 5.5a9.2 9.2 0 0 0 0 13 M18.5 5.5a9.2 9.2 0 0 1 0 13",
  wildfire:
    "M12 2.8c.9 3.4 5.4 5.6 5.4 10.4a5.4 5.4 0 0 1-10.8 0c0-2.3 1.2-4 2.3-5 .1 2.1 1.1 3.3 2.3 3.3 0-3.3-1.4-5.4.8-8.7z",
  tropical_cyclone:
    "M12 9.8a2.2 2.2 0 1 0 0.001 4.4z M12 9.8a2.2 2.2 0 1 1 0.001 4.4z M4.2 10C5.6 5.4 10 3.1 14.6 3.9 M19.8 14c-1.4 4.6-5.8 6.9-10.4 6.1 M14.6 3.9c3.3 1 5.5 3.9 5.6 7.2 M9.4 20.1C6.1 19.1 3.9 16.2 3.8 12.9",
  flood:
    "M2.5 8.5c1.6 0 1.6-1.6 3.2-1.6s1.6 1.6 3.2 1.6 1.6-1.6 3.2-1.6 1.6 1.6 3.2 1.6 1.6-1.6 3.2-1.6 1.6 1.6 3.2 1.6 M2.5 13c1.6 0 1.6-1.6 3.2-1.6s1.6 1.6 3.2 1.6 1.6-1.6 3.2-1.6 1.6 1.6 3.2 1.6 1.6-1.6 3.2-1.6 1.6 1.6 3.2 1.6 M2.5 17.5c1.6 0 1.6-1.6 3.2-1.6s1.6 1.6 3.2 1.6 1.6-1.6 3.2-1.6 1.6 1.6 3.2 1.6 1.6-1.6 3.2-1.6 1.6 1.6 3.2 1.6",
  volcano: "M2.8 20.5h18.4l-5.6-9.4H8.4z M8.4 11.1l1.4-3.3h4.4l1.4 3.3 M12 7.8V4.6 M9.6 4.4 8.4 2.9 M14.4 4.4l1.2-1.5",
  drought:
    "M12 7.2a4.8 4.8 0 1 0 0.001 0z M12 1.8v2.2 M12 20v2.2 M1.8 12H4 M20 12h2.2 M4.8 4.8l1.5 1.5 M17.7 17.7l1.5 1.5 M4.8 19.2l1.5-1.5 M17.7 6.3l1.5-1.5 M10.4 10.4l1.4 1.8-1 1.6",
  severe_storm: "M13.2 2 5.4 13.4h6.1L10.6 22l8.1-11.6h-6.1z",
  tsunami:
    "M2 18c3 0 4.1-2.1 6.1-2.1s3 2.1 6 2.1 4.1-2.1 6.1-2.1 M3.4 12.6C4.9 7.3 9.1 4.7 13.3 5.6c-2.1 1.1-3.1 3.2-2.1 5.3 1.2 2.4 4.1 2.1 5.2.5",
  landslide: "M2.8 20.5 9.9 9.3l4 5.1 2.1-3.1 5.2 9.2z M14.2 6.8l2-2 M17.1 9l1.6-1.1",
  extreme_heat: "M10 13.6V5a2 2 0 1 1 4 0v8.6a4.1 4.1 0 1 1-4 0z M12 8.6v7.6",
  extreme_cold: "M12 2v20 M3.3 7l17.4 10 M20.7 7 3.3 17 M9.5 3.6 12 6.1l2.5-2.5 M9.5 20.4l2.5-2.5 2.5 2.5",
  air_quality: "M3 8h11a3 3 0 1 0-3-3 M3 12h15a3 3 0 1 1-3 3 M3 16h7",
  sea_lake_ice: "M4 15 8 7h8l4 8z M2.5 18.5c2.4 0 2.4-1.4 4.8-1.4s2.4 1.4 4.8 1.4 2.4-1.4 4.8-1.4 2.4 1.4 4.8 1.4",
  dust_haze: "M3 7h12 M6 11h15 M3 15h12 M8 19h9",
  other: "M12 7a5 5 0 1 0 0.001 0z",
} satisfies Record<HazardId, string>;

export const HAZARDS: Record<HazardId, HazardMeta> = {
  earthquake: { id: "earthquake", label: "Earthquake", plural: "Earthquakes", short: "EQ", color: "#f2b84b", glyph: G.earthquake },
  tropical_cyclone: { id: "tropical_cyclone", label: "Tropical cyclone", plural: "Cyclones", short: "TC", color: "#a08cff", glyph: G.tropical_cyclone },
  wildfire: { id: "wildfire", label: "Wildfire", plural: "Wildfires", short: "WF", color: "#ff6b3d", glyph: G.wildfire },
  flood: { id: "flood", label: "Flood", plural: "Floods", short: "FL", color: "#3ea8f2", glyph: G.flood },
  volcano: { id: "volcano", label: "Volcanic activity", plural: "Volcanoes", short: "VO", color: "#f0507f", glyph: G.volcano },
  drought: { id: "drought", label: "Drought", plural: "Droughts", short: "DR", color: "#c9a26b", glyph: G.drought },
  severe_storm: { id: "severe_storm", label: "Severe storm", plural: "Storms", short: "ST", color: "#9fb6cc", glyph: G.severe_storm },
  tsunami: { id: "tsunami", label: "Tsunami", plural: "Tsunamis", short: "TS", color: "#2fd1bd", glyph: G.tsunami },
  landslide: { id: "landslide", label: "Landslide", plural: "Landslides", short: "LS", color: "#b98a63", glyph: G.landslide },
  extreme_heat: { id: "extreme_heat", label: "Extreme heat", plural: "Heat events", short: "HT", color: "#ff8f5c", glyph: G.extreme_heat },
  extreme_cold: { id: "extreme_cold", label: "Extreme cold", plural: "Cold events", short: "CD", color: "#8fd0ff", glyph: G.extreme_cold },
  air_quality: { id: "air_quality", label: "Air quality", plural: "Air quality", short: "AQ", color: "#b7a3c9", glyph: G.air_quality },
  sea_lake_ice: { id: "sea_lake_ice", label: "Sea & lake ice", plural: "Ice", short: "IC", color: "#d6ecff", glyph: G.sea_lake_ice },
  dust_haze: { id: "dust_haze", label: "Dust & haze", plural: "Dust & haze", short: "DH", color: "#d9b98c", glyph: G.dust_haze },
  other: { id: "other", label: "Other", plural: "Other", short: "OT", color: "#94a3b8", glyph: G.other },
};

export const PRIMARY_HAZARDS: HazardId[] = ["earthquake", "tropical_cyclone", "wildfire", "flood", "volcano", "drought"];

export function hazardMeta(id: string): HazardMeta {
  return HAZARDS[id as HazardId] ?? HAZARDS.other;
}

export const SEVERITY_COLORS = ["#4a5463", "#7d8899", "#c7b660", "#f0a43a", "#f4673c", "#ff3d71"] as const;
export const SEVERITY_LABELS = ["Unknown", "Minor", "Moderate", "Significant", "Severe", "Extreme"] as const;

export function severityColor(level: number): string {
  return SEVERITY_COLORS[Math.max(0, Math.min(5, Math.round(level)))] ?? SEVERITY_COLORS[0];
}

export const PROVENANCE_META = {
  real: { label: "Observed", short: "OBS", color: "#8fd8b8", description: "Reported by an authoritative source." },
  derived: { label: "Derived", short: "DRV", color: "#9cc9ff", description: "Computed by ATLAS from real data with a documented method." },
  model: { label: "Model estimate", short: "MDL", color: "#d6b6ff", description: "Output of an identified statistical or physical model." },
  simulation: { label: "Simulation", short: "SIM", color: "#ffb86b", description: "Hypothetical scenario output — not an observation or forecast." },
  unavailable: { label: "Unavailable", short: "N/A", color: "#6f7a8a", description: "Not enough reliable information exists." },
} as const;

export const SOURCE_LABELS: Record<string, string> = {
  usgs: "USGS",
  gdacs: "GDACS",
  nhc: "NOAA NHC",
  eonet: "NASA EONET",
  gvp: "Smithsonian GVP",
  firms: "NASA FIRMS",
  reliefweb: "ReliefWeb",
  "open-meteo": "Open-Meteo",
  "natural-earth": "Natural Earth",
  gibs: "NASA GIBS",
  "eox-s2cloudless": "EOxCloudless",
  "osm-overpass": "OpenStreetMap",
  "ghsl-pop": "GHSL",
  openaq: "OpenAQ",
  emsc: "EMSC",
  tsunami: "NOAA Tsunami Centers",
  swpc: "NOAA SWPC",
  "earth-search": "Sentinel-2",
  "terrain-tiles": "Terrain Tiles",
};

export function sourceLabel(id: string): string {
  return SOURCE_LABELS[id] ?? id;
}

/** Infrastructure facility glyphs (24×24), shared by the panel and globe sprites. */
export const FACILITY_META = {
  hospital: { label: "Hospital", glyph: "M9.5 3.5h5v6h6v5h-6v6h-5v-6h-6v-5h6z" },
  fire_station: {
    label: "Fire station",
    glyph: "M4 20.5v-10l8-6.5 8 6.5v10z M12 18.2a2.6 2.6 0 0 1-2.6-2.6c0-1.7 2.6-4.3 2.6-4.3s2.6 2.6 2.6 4.3a2.6 2.6 0 0 1-2.6 2.6z",
  },
  shelter: { label: "Shelter / assembly point", glyph: "M3 11.5l9-7.5 9 7.5 M5.2 10v10.5h13.6V10 M10 20.5v-6h4v6" },
  airport: {
    label: "Airport",
    glyph: "M21 15.5l-8-4.2V5.2a1.1 1.1 0 0 0-2.2 0v6.1l-7.8 4.2v2.1l7.8-2.2v4.3l-2.1 1.5v1.6l3.2-1 3.2 1v-1.6L13 19.7v-4.3l8 2.2z",
  },
  port: { label: "Port / harbour", glyph: "M12 3.6a1.9 1.9 0 1 0 0.001 0z M12 7.4v13.4 M5 13.6a7 7 0 0 0 14 0 M8.2 10.6h7.6" },
  water: { label: "Water / wastewater works", glyph: "M12 3.2c3.1 4.2 6 7.2 6 11a6 6 0 0 1-12 0c0-3.8 2.9-6.8 6-11z" },
} as const;

export type FacilityKey = keyof typeof FACILITY_META;

/** Exposure rings per hazard — mirrors the engine's RINGS_KM so map and tables agree. */
export const EXPOSURE_RINGS_KM: Partial<Record<HazardId, number[]>> = {
  earthquake: [5, 10, 25, 50],
  volcano: [5, 10, 25, 50],
  wildfire: [5, 10, 25],
  tropical_cyclone: [25, 50, 100],
  severe_storm: [25, 50, 100],
  landslide: [5, 10, 25],
  tsunami: [10, 25, 50],
};
