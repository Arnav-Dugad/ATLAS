/**
 * Situation report: a brief built only from templates over ATLAS's own records, so every
 * sentence ends in numbered citations to the sources behind it. Nothing is generated freely;
 * the local analyst can be asked for a summary separately, and its answer carries its own
 * citations.
 */
import type { IncidentSummary, SourceStatus } from "./api";
import { compoundGroups } from "./compound";
import { metricValue, utcFull } from "./format";
import { hazardMeta, sourceLabel } from "./hazards";

export interface SitrepInput {
  incidents: IncidentSummary[];
  sources: SourceStatus[];
  /** label reads inside a sentence ("worldwide", "in the current view"); name titles the report */
  scope: { label: string; name: string; bbox: [number, number, number, number] | null };
  windowLabel: string;
  changes24h: { created: number; escalated: number };
  now?: Date;
}

export interface Sitrep {
  title: string;
  generatedAt: string;
  paragraphs: { heading: string; sentences: { text: string; cites: number[] }[] }[];
  references: { n: number; label: string; detail: string; url: string | null }[];
}

const capitalise = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

function inBox(i: IncidentSummary, b: [number, number, number, number] | null): boolean {
  if (!b) return true;
  if (i.lat == null || i.lon == null) return false;
  const [w, s, e, n] = b;
  const lonOk = w <= e ? i.lon >= w && i.lon <= e : i.lon >= w || i.lon <= e;
  return i.lat >= s && i.lat <= n && lonOk;
}

export function buildSitrep(input: SitrepInput): Sitrep {
  const now = input.now ?? new Date();
  const refs = new Map<string, { n: number; label: string; detail: string; url: string | null }>();
  const cite = (key: string, label: string, detail: string, url: string | null): number => {
    const hit = refs.get(key);
    if (hit) return hit.n;
    const n = refs.size + 1;
    refs.set(key, { n, label, detail, url });
    return n;
  };
  const meta = new Map(input.sources.map((s) => [s.id, s]));
  const citeSource = (id: string): number => {
    const s = meta.get(id);
    const m = (s?.meta ?? {}) as { name?: string; attribution?: string; homepage?: string; license?: { name?: string } };
    return cite(`src:${id}`, m.name ?? sourceLabel(id), [m.attribution, m.license?.name].filter(Boolean).join(" · "), m.homepage ?? null);
  };
  const citeAtlas = (i: IncidentSummary): number => cite(`inc:${i.id}`, `ATLAS ${i.id}`, `${i.title} — fused record, updated ${utcFull(i.updated_at)}`, null);

  const active = input.incidents.filter((i) => i.status === "active" && inBox(i, input.scope.bbox));
  const monitoring = input.incidents.filter((i) => i.status === "monitoring" && inBox(i, input.scope.bbox));
  const paragraphs: Sitrep["paragraphs"] = [];

  // Overview
  const byHazard = new Map<string, IncidentSummary[]>();
  for (const i of active) byHazard.set(i.hazard, [...(byHazard.get(i.hazard) ?? []), i]);
  const parts = [...byHazard.entries()].sort((a, b) => b[1].length - a[1].length).map(([h, list]) => `${list.length} ${list.length === 1 ? hazardMeta(h).label.toLowerCase() : hazardMeta(h).plural.toLowerCase()}`);
  const allSources = [...new Set(active.flatMap((i) => i.sources))];
  const overview = [
    {
      text: active.length
        ? `ATLAS tracks ${active.length} active incident${active.length === 1 ? "" : "s"} ${input.scope.label}${parts.length ? ` (${parts.join(", ")})` : ""}, and ${monitoring.length} more under monitoring.`
        : `ATLAS tracks no active incidents ${input.scope.label}; ${monitoring.length} are under monitoring.`,
      cites: allSources.slice(0, 8).map(citeSource),
    },
  ];
  if (input.changes24h.created || input.changes24h.escalated) {
    overview.push({
      text: `In the last 24 hours ${input.changes24h.created} incident${input.changes24h.created === 1 ? " was" : "s were"} opened and ${input.changes24h.escalated} escalated in severity.`,
      cites: [cite("atlas:changes", "ATLAS change log", "Recorded changes to fused incidents (severity, status, sources)", null)],
    });
  }
  paragraphs.push({ heading: "Overview", sentences: overview });

  // Most severe
  const severe = [...active].sort((a, b) => b.severity.level - a.severity.level || Date.parse(b.last_observation_at) - Date.parse(a.last_observation_at)).slice(0, 8);
  if (severe.length) {
    paragraphs.push({
      heading: "Most severe",
      sentences: severe.map((i) => {
        const m = i.headline[0];
        const metric = m ? `; ${m.label.toLowerCase()} ${metricValue(m.value, m.unit)}` : "";
        return {
          text: `${i.title}: ${i.severity.label.toLowerCase()} on the ATLAS scale${metric}, last observed ${utcFull(i.last_observation_at)}.`,
          cites: [...i.sources.map(citeSource), citeAtlas(i)],
        };
      }),
    });
  }

  // Compound
  const groups = compoundGroups(active).slice(0, 5);
  if (groups.length) {
    paragraphs.push({
      heading: "Compound events",
      sentences: groups.map((g) => ({
        text: `${capitalise(g.hazards.map((h) => hazardMeta(h).label.toLowerCase()).join(" and "))} incidents are active within 300 km of each other near ${g.lead.place?.name ?? g.lead.title}.`,
        cites: g.members.slice(0, 4).map(citeAtlas),
      })),
    });
  }

  return {
    title: `Situation report — ${input.scope.name}`,
    generatedAt: now.toISOString(),
    paragraphs,
    references: [...refs.values()].sort((a, b) => a.n - b.n),
  };
}

export function sitrepMarkdown(r: Sitrep, windowLabel: string): string {
  const out = [`# ATLAS ${r.title}`, "", `Generated ${utcFull(r.generatedAt)} · time window ${windowLabel}`, ""];
  for (const p of r.paragraphs) {
    out.push(`## ${p.heading}`, "");
    for (const s of p.sentences) out.push(`- ${s.text} ${s.cites.map((n) => `[${n}]`).join("")}`);
    out.push("");
  }
  out.push("## References", "");
  for (const ref of r.references) out.push(`${ref.n}. **${ref.label}**${ref.detail ? ` — ${ref.detail}` : ""}${ref.url ? ` <${ref.url}>` : ""}`);
  out.push(
    "",
    "_Built by ATLAS from its own records with fixed templates; severity is an ordinal ATLAS scale, not an impact estimate. Not an official alert: follow your national authorities._",
  );
  return out.join("\n");
}
