/** Sun position helpers (no CesiumJS), shared by the globe and the overpass predictor. */

/** Sub-solar point (degrees) — USNO approximate solar coordinates, good to about 1′ for 1950–2050. */
export function subsolarPoint(ms: number): { lat: number; lon: number } {
  const d = ms / 86_400_000 + 2440587.5 - 2451545.0;
  const rad = Math.PI / 180;
  const g = (357.529 + 0.98560028 * d) * rad;
  const q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * rad;
  const e = (23.439 - 0.00000036 * d) * rad;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L)) / rad;
  const dec = Math.asin(Math.sin(e) * Math.sin(L)) / rad;
  const gmst = (18.697374558 + 24.06570982441908 * d) % 24;
  let lon = ra - gmst * 15;
  lon = ((((lon + 180) % 360) + 360) % 360) - 180;
  return { lat: dec, lon };
}

/** Sun elevation (degrees) at a place: 90° minus its angular distance from the sub-solar point. */
export function sunElevation(lat: number, lon: number, ms: number): number {
  const s = subsolarPoint(ms);
  const r = Math.PI / 180;
  const c = Math.sin(lat * r) * Math.sin(s.lat * r) + Math.cos(lat * r) * Math.cos(s.lat * r) * Math.cos((lon - s.lon) * r);
  return 90 - Math.acos(Math.max(-1, Math.min(1, c))) / r;
}

/** Local mean solar time (hours) at a longitude. */
export function localSolarHour(lon: number, ms: number): number {
  const utcH = (ms / 3_600_000) % 24;
  return (((utcH + lon / 15) % 24) + 24) % 24;
}
