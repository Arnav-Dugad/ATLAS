/** Formatting helpers. All times are shown in UTC by default, with relative ages alongside. */
import { useSettings, type Units } from "./settings";

const compactFmt = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const intFmt = new Intl.NumberFormat("en");

export function parseTime(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

export function relTime(iso: string | number | null | undefined, now: number = Date.now()): string {
  const t = typeof iso === "number" ? iso : parseTime(iso);
  if (t === null) return "—";
  const d = (now - t) / 1000;
  const future = d < 0;
  const a = Math.abs(d);
  let out: string;
  if (a < 45) out = `${Math.max(1, Math.round(a))}s`;
  else if (a < 3600) out = `${Math.round(a / 60)}m`;
  else if (a < 86400) {
    const h = Math.floor(a / 3600);
    const m = Math.round((a % 3600) / 60);
    out = h < 6 && m ? `${h}h ${m}m` : `${Math.round(a / 3600)}h`;
  } else if (a < 86400 * 45) out = `${Math.round(a / 86400)}d`;
  else if (a < 86400 * 400) out = `${Math.round(a / (86400 * 30))}mo`;
  else out = `${(a / (86400 * 365)).toFixed(1)}y`;
  if (a < 10) return "just now";
  return future ? `in ${out}` : `${out} ago`;
}

/**
 * Age of an observation. Agencies stamp some products with their nominal issue time (e.g. an NHC
 * intermediate advisory released a few minutes early), so a small future skew reads "just now".
 */
export function observedAgo(iso: string | null | undefined, now: number = Date.now()): string {
  const t = parseTime(iso);
  if (t !== null && t > now && t - now < 30 * 60_000) return "just now";
  return relTime(iso, now);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number) => String(n).padStart(2, "0");

/** "01 Oct 03:00Z" */
export function utcShort(iso: string | number | null | undefined): string {
  const t = typeof iso === "number" ? iso : parseTime(iso);
  if (t === null) return "—";
  const d = new Date(t);
  return `${pad(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}Z`;
}

/** "2026-10-01 03:00:12 UTC" */
export function utcFull(iso: string | number | null | undefined): string {
  const t = typeof iso === "number" ? iso : parseTime(iso);
  if (t === null) return "—";
  const d = new Date(t);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(
    d.getUTCMinutes(),
  )}:${pad(d.getUTCSeconds())} UTC`;
}

export function utcDate(iso: string | number | null | undefined): string {
  const t = typeof iso === "number" ? iso : parseTime(iso);
  if (t === null) return "—";
  const d = new Date(t);
  return `${pad(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export function localTime(iso: string | number | null | undefined): string {
  const t = typeof iso === "number" ? iso : parseTime(iso);
  if (t === null) return "—";
  return new Date(t).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function coord(lat: number | null | undefined, lon: number | null | undefined, digits = 2): string {
  if (lat == null || lon == null) return "—";
  const ns = lat >= 0 ? "N" : "S";
  const ew = lon >= 0 ? "E" : "W";
  return `${Math.abs(lat).toFixed(digits)}°${ns} ${Math.abs(lon).toFixed(digits)}°${ew}`;
}

export function compact(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return Math.abs(n) < 10_000 ? intFmt.format(Math.round(n)) : compactFmt.format(n);
}

export function int(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return intFmt.format(Math.round(n));
}

export function decimal(n: number | null | undefined, digits = 1): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toFixed(digits);
}

export function bytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function duration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return "—";
  const s = Math.abs(seconds);
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${(s / 3600).toFixed(s < 36000 ? 1 : 0)}h`;
  return `${(s / 86400).toFixed(1)}d`;
}

// ---------------------------------------------------------------- display units
// Values are stored and labelled in their source units; only the display converts.
function units(): Units {
  return useSettings.getState().units;
}

/** Convert a number shown in `unit` to the user's preferred unit. */
export function convert(value: number, unit: string): { value: number; unit: string } {
  const u = units();
  if ((unit === "km" || unit === "km from source") && u.distance === "mi") return { value: value * 0.621371, unit: unit.replace("km", "mi") };
  if (unit === "km²" && u.distance === "mi") return { value: value * 0.386102, unit: "mi²" };
  if (unit === "m" && u.distance === "mi") return { value: value * 3.28084, unit: "ft" };
  if (unit === "kt" && u.wind === "kmh") return { value: value * 1.852, unit: "km/h" };
  if (unit === "kt" && u.wind === "mph") return { value: value * 1.150779, unit: "mph" };
  if ((unit === "°C" || unit === "C") && u.temperature === "F") return { value: (value * 9) / 5 + 32, unit: "°F" };
  if (unit === "km/h" && u.wind === "kt") return { value: value / 1.852, unit: "kt" };
  if (unit === "km/h" && u.wind === "mph") return { value: value / 1.609344, unit: "mph" };
  return { value, unit };
}

/** "1,234 km" / "767 mi" */
export function dist(km: number | null | undefined, digits = 0): string {
  if (km == null || !Number.isFinite(km)) return "—";
  const c = convert(km, "km");
  return `${c.value.toLocaleString("en", { maximumFractionDigits: digits })} ${c.unit}`;
}

/** "45 kt" / "83 km/h" / "52 mph" */
export function windSpeed(kt: number | null | undefined): string {
  if (kt == null || !Number.isFinite(kt)) return "—";
  const c = convert(kt, "kt");
  return `${Math.round(c.value)} ${c.unit}`;
}

/** "31.2 °C" / "88.2 °F" */
export function temperature(c: number | null | undefined, digits = 1): string {
  if (c == null || !Number.isFinite(c)) return "—";
  const v = convert(c, "°C");
  return `${v.value.toFixed(digits)} ${v.unit}`;
}

export function metricValue(rawValue: unknown, rawUnit?: string | null): string {
  if (rawValue === null || rawValue === undefined) return "—";
  let value = rawValue;
  let unit = rawUnit;
  if (typeof value === "number" && unit) ({ value, unit } = convert(value, unit));
  if (typeof value === "number") {
    if (Number.isInteger(value)) return unit ? `${int(value)} ${unit}` : int(value as number);
    const abs = Math.abs(value);
    const txt = abs >= 1000 ? int(value) : abs >= 100 ? value.toFixed(0) : abs >= 10 ? value.toFixed(1) : value.toFixed(abs < 1 && abs > 0 ? 2 : 1);
    return unit ? `${txt} ${unit}` : txt;
  }
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return unit ? `${String(value)} ${unit}` : String(value);
}

export function titleCase(s: string): string {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
