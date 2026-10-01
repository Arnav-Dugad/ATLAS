/**
 * Satellite ground tracks and overpass predictions from public orbits (CelesTrak TLE, SGP4 via
 * satellite.js). An overpass is a geometric opportunity — the incident is inside the
 * satellite's swath in daylight — not a promise that an image will be taken: that depends on
 * each mission's acquisition plan and, for optical sensors, on clouds.
 */
import { degreesLat, degreesLong, eciToGeodetic, gstime, propagate, type SatRec, twoline2satrec } from "satellite.js";
import { localSolarHour, sunElevation } from "./sun";

export interface Tle {
  name: string;
  line1: string;
  line2: string;
  norad: number;
  mission: string;
  swath_km: number;
}

export interface Satellite extends Tle {
  rec: SatRec;
}

export function loadSatellites(tles: Tle[]): Satellite[] {
  const out: Satellite[] = [];
  for (const t of tles) {
    try {
      out.push({ ...t, rec: twoline2satrec(t.line1, t.line2) });
    } catch {
      /* skip a malformed element set */
    }
  }
  return out;
}

export function subSatellite(sat: Satellite, at: Date): { lat: number; lon: number } | null {
  const pv = propagate(sat.rec, at);
  if (!pv || typeof pv.position !== "object") return null;
  const g = eciToGeodetic(pv.position, gstime(at));
  return { lat: degreesLat(g.latitude), lon: degreesLong(g.longitude) };
}

export function groundTrack(sat: Satellite, from: Date, minutes = 100, stepS = 30): { lat: number; lon: number }[] {
  const out: { lat: number; lon: number }[] = [];
  for (let s = 0; s <= minutes * 60; s += stepS) {
    const p = subSatellite(sat, new Date(from.getTime() + s * 1000));
    if (p) out.push(p);
  }
  return out;
}

function distanceKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const r = Math.PI / 180;
  const h = Math.sin(((bLat - aLat) * r) / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(((bLon - aLon) * r) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

export interface Overpass {
  satellite: string;
  mission: string;
  /** closest approach, ms */
  at: number;
  /** distance from the ground track to the place (km); inside the swath when ≤ swath/2 */
  offTrackKm: number;
  swathKm: number;
  sunElevation: number;
  localSolarHour: number;
}

/**
 * Daylight passes that put (lat, lon) inside each satellite's swath during the next `days`.
 * Coarse 30 s steps find each approach; 2 s steps refine the closest point.
 */
export function nextOverpasses(sats: Satellite[], lat: number, lon: number, from: number, days = 6): Overpass[] {
  const out: Overpass[] = [];
  const end = from + days * 86_400_000;
  for (const sat of sats) {
    const half = sat.swath_km / 2;
    let prev = Infinity;
    let falling = false;
    for (let t = from; t <= end; t += 30_000) {
      const p = subSatellite(sat, new Date(t));
      if (!p) continue;
      const d = distanceKm(p.lat, p.lon, lat, lon);
      if (d > prev && falling && prev < half + 250) {
        // refine around the minimum just passed
        let best = { t: t - 30_000, d: prev };
        for (let u = t - 60_000; u <= t; u += 2_000) {
          const q = subSatellite(sat, new Date(u));
          if (!q) continue;
          const dd = distanceKm(q.lat, q.lon, lat, lon);
          if (dd < best.d) best = { t: u, d: dd };
        }
        const elev = sunElevation(lat, lon, best.t);
        if (best.d <= half && elev > 5) {
          out.push({
            satellite: sat.name,
            mission: sat.mission,
            at: best.t,
            offTrackKm: Math.round(best.d),
            swathKm: sat.swath_km,
            sunElevation: Math.round(elev),
            localSolarHour: localSolarHour(lon, best.t),
          });
        }
      }
      falling = d < prev;
      prev = d;
    }
  }
  return out.sort((a, b) => a.at - b.at);
}
