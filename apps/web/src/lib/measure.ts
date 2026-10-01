/**
 * Measuring on the globe: a path (distance) or a closed area, drawn point by point.
 * Geometry is on a sphere of the mean Earth radius — within ~0.5% of the WGS84 ellipsoid,
 * which is well inside what anyone can click on a globe.
 */
import { create } from "zustand";

export type MeasureMode = "distance" | "area";
export interface LatLon {
  lat: number;
  lon: number;
}

const R_KM = 6371.0088;
const rad = (d: number) => (d * Math.PI) / 180;

export function haversineKm(a: LatLon, b: LatLon): number {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Length of the path through the points (closing it back to the start when `closed`). */
export function pathKm(points: LatLon[], closed = false): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += haversineKm(points[i - 1]!, points[i]!);
  if (closed && points.length > 2) total += haversineKm(points[points.length - 1]!, points[0]!);
  return total;
}

/** Area enclosed by the points on the sphere (km²); the same formula the engine uses. */
export function areaKm2(points: LatLon[]): number {
  if (points.length < 3) return 0;
  let total = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    let dLon = b.lon - a.lon;
    if (dLon > 180) dLon -= 360; // the short way across the antimeridian
    if (dLon < -180) dLon += 360;
    total += rad(dLon) * (2 + Math.sin(rad(a.lat)) + Math.sin(rad(b.lat)));
  }
  return (Math.abs(total) * R_KM * R_KM) / 2;
}

/** Initial great-circle bearing a → b, degrees clockwise from north. */
export function bearingDeg(a: LatLon, b: LatLon): number {
  const y = Math.sin(rad(b.lon - a.lon)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon - a.lon));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

export function toGeoJSON(points: LatLon[], mode: MeasureMode): string {
  const ring = points.map((p) => [Number(p.lon.toFixed(6)), Number(p.lat.toFixed(6))]);
  const geometry =
    mode === "area" && ring.length >= 3 ? { type: "Polygon", coordinates: [[...ring, ring[0]]] } : { type: "LineString", coordinates: ring };
  return JSON.stringify({ type: "Feature", properties: { source: "ATLAS measure" }, geometry }, null, 2);
}

interface MeasureState {
  /** the tool is open (shape and panel shown) */
  active: boolean;
  /** clicks on the globe add points */
  drawing: boolean;
  mode: MeasureMode;
  points: LatLon[];
  start: (mode?: MeasureMode, first?: LatLon) => void;
  add: (p: LatLon) => void;
  undo: () => void;
  clear: () => void;
  setMode: (m: MeasureMode) => void;
  setDrawing: (on: boolean) => void;
  stop: () => void;
}

export const MAX_POINTS = 200;

export const useMeasure = create<MeasureState>()((set) => ({
  active: false,
  drawing: false,
  mode: "distance",
  points: [],
  start: (mode, first) => set((s) => ({ active: true, drawing: true, mode: mode ?? s.mode, points: first ? [first] : [] })),
  add: (p) => set((s) => (!s.drawing || s.points.length >= MAX_POINTS ? s : { points: [...s.points, p] })),
  undo: () => set((s) => ({ points: s.points.slice(0, -1) })),
  clear: () => set({ points: [] }),
  setMode: (mode) => set({ mode }),
  setDrawing: (drawing) => set({ drawing }),
  stop: () => set({ active: false, drawing: false, points: [] }),
}));

export function startMeasure(first?: LatLon) {
  useMeasure.getState().start(undefined, first);
}

export function toggleMeasure() {
  const m = useMeasure.getState();
  if (m.active) m.stop();
  else m.start();
}
