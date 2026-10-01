/**
 * Earthquake shaking scenario — SIMULATION, NOT A FORECAST.
 * Same equation as the engine (services/engine/src/atlas/engine/simulation.py) so bands can be
 * drawn instantly and on the static public snapshot; residents per band come from the engine.
 * Allen, Wald & Worden (2012), hypocentral-distance form, coefficients as in GEM OpenQuake.
 */
import { API_BASE, ApiError, STATIC_MODE } from "./api";

const C0 = 2.085;
const C1 = 1.428;
const C2 = -1.402;
const C4 = 0.078;
const M1 = -0.209;
const M2 = 2.042;
const S1 = 0.82;
const S2 = 0.37;
const S3 = 22.9;
const MAX_KM = 1500;

export const MMI_LEVELS: { level: number; roman: string; shaking: string; damage: string; color: string }[] = [
  { level: 10, roman: "X+", shaking: "Extreme", damage: "Very heavy", color: "#c80000" },
  { level: 9, roman: "IX", shaking: "Violent", damage: "Heavy", color: "#ff0000" },
  { level: 8, roman: "VIII", shaking: "Severe", damage: "Moderate/heavy", color: "#ff9100" },
  { level: 7, roman: "VII", shaking: "Very strong", damage: "Moderate", color: "#ffc800" },
  { level: 6, roman: "VI", shaking: "Strong", damage: "Light", color: "#ffff00" },
  { level: 5, roman: "V", shaking: "Moderate", damage: "Very light", color: "#7aff93" },
  { level: 4, roman: "IV", shaking: "Light", damage: "None", color: "#80ffff" },
];

export function mmi(magnitude: number, rhypoKm: number): number {
  const r = Math.max(rhypoKm, 0.1);
  const rm = M1 + M2 * Math.exp(magnitude - 5);
  let f = C2 * Math.log(Math.sqrt(r * r + rm * rm));
  if (r > 50) f += C4 * Math.log(r / 50);
  return C0 + C1 * magnitude + f;
}

export function sigma(rhypoKm: number): number {
  return S1 + S2 / (1 + (rhypoKm / S3) ** 2);
}

export function radiusKm(level: number, magnitude: number, depthKm: number): number | null {
  const at = (d: number) => mmi(magnitude, Math.hypot(d, depthKm));
  if (at(0) < level) return null;
  if (at(MAX_KM) >= level) return MAX_KM;
  let lo = 0;
  let hi = MAX_KM;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (at(mid) >= level) lo = mid;
    else hi = mid;
  }
  return Math.round(lo * 100) / 100;
}

export interface ScenarioInput {
  lat: number;
  lon: number;
  magnitude: number;
  depth_km: number;
}

export interface ScenarioBand {
  level: number;
  roman: string;
  shaking: string;
  damage: string;
  color: string;
  radius_km: number;
  sigma_at_edge: number;
  residents_within?: number;
  residents_in_band?: number;
}

export interface Scenario {
  status: "ok";
  kind: "earthquake_scenario";
  provenance: "simulation";
  label: string;
  input: ScenarioInput;
  epicentre_mmi: number;
  bands: ScenarioBand[];
  model: { name: string; citation: string; uncertainty: string };
  population_dataset: string | null;
  population_note: string | null;
  notes: string[];
  caveats: string[];
}

const CAVEATS = [
  "A simulation of a hypothetical event, not a forecast: it says nothing about whether or when an earthquake will happen.",
  "Median intensity only: real shaking at a site commonly differs by about ±1 intensity unit (σ shown).",
  "Point source: large earthquakes rupture faults tens to hundreds of km long and shake an elongated area more widely.",
  "No site effects: soft soils and sedimentary basins amplify shaking; hard rock reduces it.",
  "Calibrated for shallow earthquakes in active crustal regions (about M 5–7.9); stable continental regions attenuate more slowly.",
  "Residents are a GHSL model of where people live, not people affected; no damage, casualty or loss estimate is made.",
];

/** Bands computed in the browser (no residents) — used on the static snapshot and while dragging. */
export function localScenario(input: ScenarioInput): Scenario {
  const notes: string[] = [];
  if (input.magnitude < 5 || input.magnitude > 7.9)
    notes.push(`M${input.magnitude.toFixed(1)} is outside the equation's calibration range (about M 5–7.9); treat the result as indicative only.`);
  if (input.depth_km > 40) notes.push(`A ${input.depth_km.toFixed(0)} km deep event is not a shallow crustal earthquake; the equation was not derived for it.`);
  const bands: ScenarioBand[] = [];
  for (const l of MMI_LEVELS) {
    const r = radiusKm(l.level, input.magnitude, input.depth_km);
    if (r == null) continue;
    bands.push({ ...l, radius_km: r, sigma_at_edge: Math.round(sigma(Math.hypot(r, input.depth_km)) * 100) / 100 });
  }
  return {
    status: "ok",
    kind: "earthquake_scenario",
    provenance: "simulation",
    label: "SIMULATION — NOT A FORECAST",
    input,
    epicentre_mmi: Math.round(mmi(input.magnitude, input.depth_km) * 10) / 10,
    bands,
    model: {
      name: "Allen, Wald & Worden (2012) intensity prediction equation, hypocentral-distance form (active crustal regions)",
      citation: "Allen T.I., Wald D.J., Worden C.B. (2012). Intensity attenuation for active crustal regions. J. Seismology 16:409-433",
      uncertainty: "σ ≈ 0.8–1.2 MMI units (larger close to the source)",
    },
    population_dataset: null,
    population_note: STATIC_MODE
      ? "Residents per band are computed by the local engine (with the Population Pack); this public snapshot shows intensity bands only."
      : "Residents per band need the local engine with the optional Population Pack.",
    notes,
    caveats: CAVEATS,
  };
}

export async function engineScenario(input: ScenarioInput, signal?: AbortSignal): Promise<Scenario> {
  if (STATIC_MODE) return localScenario(input);
  const q = new URLSearchParams({ lat: String(input.lat), lon: String(input.lon), magnitude: String(input.magnitude), depth_km: String(input.depth_km) });
  const res = await fetch(`${API_BASE}/api/v1/simulate/earthquake?${q}`, { signal, headers: { Accept: "application/json" } }).catch((err: Error) => {
    if (err.name === "AbortError") throw err;
    throw new ApiError(0, "offline", "The ATLAS engine is not reachable.");
  });
  if (!res.ok) throw new ApiError(res.status, "http_error", `Scenario failed (${res.status})`);
  return (await res.json()) as Scenario;
}

