/**
 * When this viewer last looked at ATLAS, kept only in this browser. Read once at start-up
 * (that is "your last visit"), then refreshed while the page is open so the next visit starts
 * from when this one ended.
 */
const KEY = "atlas.lastVisit";
const MIN_GAP_MS = 30 * 60_000; // shorter gaps are the same visit

function read(): number | null {
  try {
    const v = Number(localStorage.getItem(KEY));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

function write(t: number) {
  try {
    localStorage.setItem(KEY, String(t));
  } catch {
    /* private window or blocked storage: the feature simply stays off */
  }
}

const stored = read();
/** The previous visit (ms), or null on a first visit or when it was under 30 minutes ago. */
export const previousVisit: number | null = stored && Date.now() - stored >= MIN_GAP_MS ? stored : null;

let started = false;
export function trackVisits() {
  if (started) return;
  started = true;
  const mark = () => write(Date.now());
  // Not on first load: a quick reload must not erase the summary of what changed.
  window.setInterval(mark, 5 * 60_000);
  document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && mark());
  window.addEventListener("pagehide", mark);
}

/** Group the change feed into what a returning viewer wants first. */
export function summarise<T extends { kind: string; incident_id: string; significance: number; new_value?: string | null }>(items: T[]) {
  const created = new Set<string>();
  const escalated = new Set<string>();
  const ended = new Set<string>();
  for (const c of items) {
    if (c.kind === "created") created.add(c.incident_id);
    else if (c.kind === "severity_changed" && c.significance >= 2 && /raised/i.test((c as { summary?: string }).summary ?? "")) escalated.add(c.incident_id);
    else if (c.kind === "status_changed" && (c.new_value === "closed" || /→ closed/.test((c as { summary?: string }).summary ?? ""))) ended.add(c.incident_id);
  }
  for (const id of created) escalated.delete(id);
  return { created: [...created], escalated: [...escalated], ended: [...ended] };
}
