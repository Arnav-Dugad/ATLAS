/**
 * Rapid intensification (RI): the standard NHC definition is an increase in maximum sustained
 * wind of at least 30 kt in 24 hours. Checked separately on the observed track (what happened)
 * and on the official forecast (what NHC forecasts) — never mixed, and never computed by ATLAS
 * beyond comparing the reported numbers.
 */
import { parseTime } from "./format";

export const RI_THRESHOLD_KT = 30;

export interface WindPoint {
  time: string;
  wind_kt?: number | null;
  kind?: "observed" | "forecast";
}

export interface RiResult {
  gainKt: number;
  from: string;
  to: string;
  rapid: boolean;
}

/** Largest wind gain over a span of 24 h (±2 h, to allow for irregular fixes). */
export function max24hGain(points: WindPoint[]): RiResult | null {
  const pts = points
    .filter((p) => typeof p.wind_kt === "number" && parseTime(p.time) !== null)
    .map((p) => ({ t: parseTime(p.time) as number, w: p.wind_kt as number, time: p.time }))
    .sort((a, b) => a.t - b.t);
  let best: RiResult | null = null;
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const hours = (pts[j]!.t - pts[i]!.t) / 3_600_000;
      if (hours < 22) continue;
      if (hours > 26) break;
      const gain = pts[j]!.w - pts[i]!.w;
      if (!best || gain > best.gainKt) best = { gainKt: gain, from: pts[i]!.time, to: pts[j]!.time, rapid: gain >= RI_THRESHOLD_KT };
    }
  }
  return best;
}

/** RI on the observed track, and in NHC's forecast (which starts from the latest observed fix). */
export function rapidIntensification(track: WindPoint[]): { observed: RiResult | null; forecast: RiResult | null } {
  const observed = track.filter((p) => p.kind !== "forecast");
  const forecast = track.filter((p) => p.kind === "forecast");
  const lastObs = observed.filter((p) => typeof p.wind_kt === "number").sort((a, b) => (parseTime(a.time) ?? 0) - (parseTime(b.time) ?? 0)).at(-1);
  return {
    observed: max24hGain(observed),
    forecast: forecast.length ? max24hGain(lastObs ? [lastObs, ...forecast] : forecast) : null,
  };
}
