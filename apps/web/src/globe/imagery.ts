/**
 * Imagery catalogue. Every layer is a free, keyless WMTS/XYZ endpoint, verified 2026-10-01.
 * Raster layers are *visualisations* (rendered colour maps), not calibrated values; the
 * legend text says so.
 */
import type { LayerId } from "../lib/store";

export interface ImageryDef {
  id: LayerId | "base" | "base.fallback" | "nightLights";
  title: string;
  group: "Base" | "Satellite" | "Atmosphere" | "Environment" | "Social" | "Reference";
  source: string;
  layer?: string;
  url: (date: string) => string;
  maximumLevel: number;
  /** days to subtract from "yesterday" to land on the latest typically-available date */
  latencyDays?: number;
  temporal: boolean;
  alpha: number;
  legend?: { gradient: string[]; min: string; max: string; unit?: string };
  description: string;
}

const GIBS = "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best";
const gibs = (layer: string, level: number, ext: "jpg" | "png" | "jpeg") => (date: string) =>
  `${GIBS}/${layer}/default/${date}/GoogleMapsCompatible_Level${level}/{z}/{y}/{x}.${ext}`;

export const BASE: ImageryDef = {
  id: "base",
  title: "Sentinel-2 cloudless 2024",
  group: "Base",
  source: "eox-s2cloudless",
  url: () => "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2024_3857/default/g/{z}/{y}/{x}.jpg",
  maximumLevel: 14,
  temporal: false,
  alpha: 1,
  description: "10 m cloud-free annual mosaic. Shows typical surface appearance, not current conditions.",
};

export const BASE_FALLBACK: ImageryDef = {
  id: "base.fallback",
  title: "Blue Marble shaded relief",
  group: "Base",
  source: "gibs",
  layer: "BlueMarble_ShadedRelief_Bathymetry",
  url: gibs("BlueMarble_ShadedRelief_Bathymetry", 8, "jpeg"),
  maximumLevel: 8,
  temporal: false,
  alpha: 1,
  description: "NASA Blue Marble with shaded relief and bathymetry.",
};

export const NIGHT_LIGHTS: ImageryDef = {
  id: "nightLights",
  title: "Night lights (Black Marble)",
  group: "Social",
  source: "gibs",
  layer: "VIIRS_Black_Marble",
  url: () => `${GIBS}/VIIRS_Black_Marble/default/2016-01-01/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png`,
  maximumLevel: 8,
  temporal: false,
  alpha: 1,
  description: "VIIRS night-time lights composite, shown on the night side of the planet.",
};

export const OVERLAYS: ImageryDef[] = [
  {
    id: "imagery.truecolor",
    title: "True colour — VIIRS NOAA-20 (daily)",
    group: "Satellite",
    source: "gibs",
    layer: "VIIRS_NOAA20_CorrectedReflectance_TrueColor",
    url: gibs("VIIRS_NOAA20_CorrectedReflectance_TrueColor", 9, "jpg"),
    maximumLevel: 9,
    latencyDays: 0,
    temporal: true,
    alpha: 1,
    description: "Corrected reflectance true-colour imagery from the selected day, including clouds and smoke.",
  },
  {
    id: "imagery.precip",
    title: "Precipitation rate — IMERG",
    group: "Atmosphere",
    source: "gibs",
    layer: "IMERG_Precipitation_Rate",
    url: gibs("IMERG_Precipitation_Rate", 6, "png"),
    maximumLevel: 6,
    latencyDays: 1,
    temporal: true,
    alpha: 0.85,
    legend: { gradient: ["#3a8ee6", "#38d0a8", "#e6e23a", "#f08a2a", "#d6327a"], min: "0.1", max: "≥ 50", unit: "mm/h" },
    description: "GPM IMERG daily precipitation rate (satellite-derived estimate).",
  },
  {
    id: "imagery.sst",
    title: "Sea surface temperature — GHRSST MUR",
    group: "Environment",
    source: "gibs",
    layer: "GHRSST_L4_MUR_Sea_Surface_Temperature",
    url: gibs("GHRSST_L4_MUR_Sea_Surface_Temperature", 7, "png"),
    maximumLevel: 7,
    latencyDays: 1,
    temporal: true,
    alpha: 0.8,
    legend: { gradient: ["#2b2a8c", "#2f7ec7", "#5fd0c0", "#f2e25b", "#e8542f"], min: "−2", max: "32", unit: "°C" },
    description: "Multi-scale ultra-high-resolution blended SST analysis.",
  },
  {
    id: "imagery.no2",
    title: "NO₂ tropospheric column — Sentinel-5P TROPOMI",
    group: "Atmosphere",
    source: "gibs",
    layer: "TROPOMI_L2_Nitrogen_Dioxide_Tropospheric_Column",
    url: gibs("TROPOMI_L2_Nitrogen_Dioxide_Tropospheric_Column", 6, "png"),
    maximumLevel: 6,
    latencyDays: 0,
    temporal: true,
    alpha: 0.85,
    legend: { gradient: ["#1d1f4a", "#6a2d8f", "#c43f6f", "#f08a4b", "#fde2a1"], min: "low", max: "high", unit: "mol/m²" },
    description: "Satellite retrieval of nitrogen dioxide (combustion, traffic, industry, fires).",
  },
  {
    id: "imagery.so2",
    title: "SO₂ total column — Sentinel-5P TROPOMI",
    group: "Atmosphere",
    source: "gibs",
    layer: "TROPOMI_L2_Sulfur_Dioxide_Total_Vertical_Column",
    url: gibs("TROPOMI_L2_Sulfur_Dioxide_Total_Vertical_Column", 6, "png"),
    maximumLevel: 6,
    latencyDays: 0,
    temporal: true,
    alpha: 0.85,
    description: "Sulphur dioxide retrieval — volcanic plumes and industrial emissions.",
  },
  {
    id: "imagery.aerosol",
    title: "Aerosol optical depth — MODIS Terra",
    group: "Atmosphere",
    source: "gibs",
    layer: "MODIS_Terra_Aerosol",
    url: gibs("MODIS_Terra_Aerosol", 6, "png"),
    maximumLevel: 6,
    latencyDays: 0,
    temporal: true,
    alpha: 0.8,
    legend: { gradient: ["#fff3b0", "#f6b94e", "#e2733b", "#a8322d", "#4b1020"], min: "0", max: "≥ 1", unit: "AOD" },
    description: "Smoke, dust and haze loading in the atmospheric column.",
  },
  {
    id: "imagery.lst",
    title: "Land surface temperature (day) — MODIS",
    group: "Environment",
    source: "gibs",
    layer: "MODIS_Terra_Land_Surface_Temp_Day",
    url: gibs("MODIS_Terra_Land_Surface_Temp_Day", 7, "png"),
    maximumLevel: 7,
    latencyDays: 1,
    temporal: true,
    alpha: 0.85,
    legend: { gradient: ["#3d2b8c", "#2f8fd0", "#5fd09a", "#f2d65b", "#e8462f"], min: "−20", max: "60", unit: "°C" },
    description: "Daytime land surface (skin) temperature — distinct from air temperature.",
  },
  {
    id: "imagery.flood",
    title: "Flood detection (2-day) — MODIS",
    group: "Environment",
    source: "gibs",
    layer: "MODIS_Combined_Flood_2-Day",
    url: gibs("MODIS_Combined_Flood_2-Day", 9, "png"),
    maximumLevel: 9,
    latencyDays: 0,
    temporal: true,
    alpha: 0.95,
    description: "NASA LANCE near-real-time surface water flagged as flood against a reference water mask.",
  },
  {
    id: "imagery.water",
    title: "Dynamic surface water — OPERA (Sentinel-1)",
    group: "Environment",
    source: "gibs",
    layer: "OPERA_L3_Dynamic_Surface_Water_Extent-Sentinel-1",
    url: gibs("OPERA_L3_Dynamic_Surface_Water_Extent-Sentinel-1", 12, "png"),
    maximumLevel: 12,
    latencyDays: 1,
    temporal: true,
    alpha: 0.95,
    description: "30 m radar-derived surface water extent (coverage is regional; zoom in).",
  },
  {
    id: "imagery.ndvi",
    title: "Vegetation index (NDVI, 8-day) — MODIS",
    group: "Environment",
    source: "gibs",
    layer: "MODIS_Terra_NDVI_8Day",
    url: gibs("MODIS_Terra_NDVI_8Day", 9, "png"),
    maximumLevel: 9,
    latencyDays: 2,
    temporal: true,
    alpha: 0.8,
    legend: { gradient: ["#8c6239", "#d9c27a", "#a7d16b", "#3f9c3a", "#0b5d1e"], min: "−0.1", max: "0.9", unit: "NDVI" },
    description: "Vegetation greenness; stress shows as lower values.",
  },
  {
    id: "imagery.population",
    title: "Population density 2020 — GPW v4",
    group: "Social",
    source: "gibs",
    layer: "GPW_Population_Density_2020",
    url: gibs("GPW_Population_Density_2020", 7, "png"),
    maximumLevel: 7,
    temporal: false,
    alpha: 0.85,
    legend: { gradient: ["#fff7d6", "#fdd38a", "#f69552", "#d9483b", "#7e1b3d"], min: "< 1", max: "> 1000", unit: "people/km²" },
    description: "Gridded Population of the World v4 (modelled residential population).",
  },
  {
    id: "imagery.relief",
    title: "Elevation colour relief — ASTER GDEM",
    group: "Environment",
    source: "gibs",
    layer: "ASTER_GDEM_Color_Shaded_Relief",
    url: gibs("ASTER_GDEM_Color_Shaded_Relief", 12, "jpeg"),
    maximumLevel: 12,
    temporal: false,
    alpha: 0.9,
    description: "Global digital elevation model as colour-shaded relief.",
  },
  {
    id: "labels",
    title: "Place labels",
    group: "Reference",
    source: "gibs",
    layer: "Reference_Labels_15m",
    url: gibs("Reference_Labels_15m", 13, "png"),
    maximumLevel: 13,
    temporal: false,
    alpha: 1,
    description: "OpenStreetMap-derived reference labels rendered by NASA GIBS.",
  },
];

export function overlayDate(def: ImageryDef, selected: string): string {
  if (!def.temporal || !def.latencyDays) return selected;
  const d = new Date(`${selected}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - def.latencyDays);
  return d.toISOString().slice(0, 10);
}

/**
 * Products for the before/after split comparison. All are NASA GIBS daily composites
 * (keyless WMTS). Each pass covers the planet once a day; clouds, smoke and swath gaps are
 * part of the picture, so two dates are compared, never a single "truth" image.
 */
export interface CompareProduct {
  id: string;
  title: string;
  short: string;
  layer: string;
  level: number;
  ext: "jpg" | "png";
  description: string;
}

export const COMPARE_PRODUCTS: CompareProduct[] = [
  {
    id: "viirs-truecolor",
    title: "True colour — VIIRS NOAA-20",
    short: "True colour",
    layer: "VIIRS_NOAA20_CorrectedReflectance_TrueColor",
    level: 9,
    ext: "jpg",
    description: "What the eye would see from orbit at ~375 m: clouds, smoke plumes, sediment and snow.",
  },
  {
    id: "viirs-firecolor",
    title: "False colour M11-I2-I1 — VIIRS NOAA-20",
    short: "Burn scars & water",
    layer: "VIIRS_NOAA20_CorrectedReflectance_BandsM11-I2-I1",
    level: 9,
    ext: "jpg",
    description: "Shortwave-infrared false colour: burn scars show red-brown, active fire bright orange, water black-blue, vegetation green.",
  },
  {
    id: "modis-721",
    title: "False colour 7-2-1 — MODIS Terra",
    short: "MODIS 7-2-1",
    layer: "MODIS_Terra_CorrectedReflectance_Bands721",
    level: 9,
    ext: "jpg",
    description: "Bands 7-2-1 at 250–500 m: flood water and burn scars stand out from vegetation and bare ground.",
  },
  {
    id: "modis-truecolor",
    title: "True colour — MODIS Terra",
    short: "MODIS true colour",
    layer: "MODIS_Terra_CorrectedReflectance_TrueColor",
    level: 9,
    ext: "jpg",
    description: "Morning-overpass true colour at 250 m; useful when the afternoon VIIRS pass is cloudy.",
  },
];

export function compareProduct(id: string): CompareProduct {
  return COMPARE_PRODUCTS.find((p) => p.id === id) ?? COMPARE_PRODUCTS[0]!;
}

export function compareUrl(p: CompareProduct, date: string): string {
  return `${GIBS}/${p.layer}/default/${date}/GoogleMapsCompatible_Level${p.level}/{z}/{y}/{x}.${p.ext}`;
}

const DAY = 86_400_000;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Sensible comparison for a hazard: a clear day before onset against the latest full day. */
export function compareDefaults(hazard: string | null, onsetIso: string | null): { product: string; before: string; after: string } {
  const latest = Date.now() - DAY; // the previous UTC day is complete in GIBS
  const onset = onsetIso ? Date.parse(onsetIso) : latest - 7 * DAY;
  const product = hazard === "wildfire" || hazard === "flood" ? "viirs-firecolor" : "viirs-truecolor";
  // Satellite detection can lag a fire's or flood's start by days; reach back far enough to
  // land before it. Earthquakes and eruptions have a precise onset.
  const leadDays = hazard === "wildfire" ? 6 : hazard === "flood" || hazard === "tropical_cyclone" ? 5 : 2;
  const before = isoDay(Math.min(onset - leadDays * DAY, latest - DAY));
  return { product, before, after: isoDay(latest) };
}
