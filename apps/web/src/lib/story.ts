/**
 * Story mode (Phase 5): a guided tour of the planet right now. Captions are templates filled
 * only with ATLAS data and its sources — no generated prose, no invented numbers.
 */
import type { IncidentSummary, Metric, Overview } from "./api";
import { metricValue, relTime } from "./format";
import { hazardMeta, sourceLabel } from "./hazards";

export interface StoryChip {
  label: string;
  value: string;
  provenance: string;
}

export interface StoryStep {
  kind: "intro" | "incident" | "outro";
  kicker: string;
  title: string;
  body: string;
  chips: StoryChip[];
  incident?: IncidentSummary;
}

const MAX_INCIDENTS = 6;

function list(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function chip(m: Metric): StoryChip {
  return { label: m.label, value: metricValue(m.value, m.unit), provenance: String(m.provenance) };
}

/** The most significant active incidents, one per hazard first so the tour shows the range. */
export function pickHighlights(incidents: IncidentSummary[], n = MAX_INCIDENTS): IncidentSummary[] {
  const active = incidents
    .filter((i) => i.status === "active" && i.lat != null && i.lon != null)
    .sort((a, b) => b.severity.level - a.severity.level || Date.parse(b.last_observation_at) - Date.parse(a.last_observation_at));
  const out: IncidentSummary[] = [];
  const seen = new Set<string>();
  for (const i of active) {
    if (out.length >= n) break;
    if (!seen.has(i.hazard)) {
      out.push(i);
      seen.add(i.hazard);
    }
  }
  for (const i of active) {
    if (out.length >= n) break;
    if (!out.includes(i)) out.push(i);
  }
  return out.sort((a, b) => b.severity.level - a.severity.level);
}

export function buildStory(overview: Overview | undefined, incidents: IncidentSummary[]): StoryStep[] {
  const steps: StoryStep[] = [];
  if (overview) {
    const parts = [`${overview.earthquakes_24h.toLocaleString()} earthquakes of magnitude 2.5 or more`];
    if (overview.fire_detections_24h) parts.push(`${overview.fire_detections_24h.toLocaleString()} satellite fire detections`);
    if (overview.active_cyclones) parts.push(`${overview.active_cyclones} active tropical cyclone${overview.active_cyclones === 1 ? "" : "s"}`);
    const top = overview.by_hazard
      .filter((h) => h.active > 0)
      .sort((a, b) => b.active - a.active)
      .slice(0, 3)
      .map((h) => `${h.active} ${hazardMeta(h.hazard).plural.toLowerCase()}`);
    steps.push({
      kind: "intro",
      kicker: "The planet right now",
      title: `${overview.incidents_active} active incidents`,
      body: `Mostly ${list(top)}. In the last 24 hours open data reported ${list(parts)}.`,
      chips: [],
    });
  }
  for (const inc of pickHighlights(incidents)) {
    const hz = hazardMeta(inc.hazard);
    const sources = list(inc.sources.map(sourceLabel));
    const place = inc.place?.description ?? inc.country_name ?? "";
    steps.push({
      kind: "incident",
      kicker: `${hz.label} · ${inc.severity.label} (${inc.severity.level}/5 on the ATLAS scale)`,
      title: inc.title,
      body: `${place ? `${place}. ` : ""}First detected ${relTime(inc.started_at)}, latest data ${relTime(inc.last_observation_at)}. Reported by ${sources || "one source"}${inc.source_count > 1 ? `, correlated from ${inc.source_count} sources` : ""}.`,
      chips: inc.headline.slice(0, 3).map(chip),
      incident: inc,
    });
  }
  steps.push({
    kind: "outro",
    kicker: "Explore",
    title: "Every number links to its source",
    body: "Open any incident for its sources, methodology and history. ATLAS is a research tool, not an official warning service: follow local authorities.",
    chips: [],
  });
  return steps;
}
