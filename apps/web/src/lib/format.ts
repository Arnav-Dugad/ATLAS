/** Formatting helpers. All times are shown in UTC by default, with relative ages alongside. */

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

export function metricValue(value: unknown, unit?: string | null): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "number") {
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
