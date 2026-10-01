import { describe, expect, it } from "vitest";
import type { IncidentSummary, SourceStatus } from "./api";
import { buildSitrep, sitrepMarkdown } from "./sitrep";

function inc(id: string, hazard: string, level: number, lat: number, lon: number, sources: string[], status = "active"): IncidentSummary {
  return {
    id,
    hazard,
    hazard_label: hazard,
    title: `${hazard} ${id}`,
    status,
    lat,
    lon,
    bbox: null,
    started_at: "2026-09-30T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
    last_observation_at: "2026-10-01T00:00:00Z",
    severity: { level, label: ["", "Minor", "Moderate", "Significant", "Severe", "Extreme"][level]!, basis: "", method: "atlas-severity-v1" },
    confidence: { score: 0.8, label: "High", method: "", components: [], note: "" },
    headline: [{ key: "magnitude", label: "Magnitude", value: 6.1, unit: "Mw", provenance: "real", source: "usgs", observed_at: null, method: null, note: null }],
    country_iso3: null,
    country_name: null,
    place: null,
    source_count: sources.length,
    sources,
  } as unknown as IncidentSummary;
}

const sources = [
  { id: "usgs", meta: { name: "USGS Earthquake Hazards Program", attribution: "U.S. Geological Survey", homepage: "https://earthquake.usgs.gov" } },
  { id: "gdacs", meta: { name: "GDACS", attribution: "EC JRC / UN OCHA" } },
] as unknown as SourceStatus[];

describe("situation report", () => {
  const r = buildSitrep({
    incidents: [inc("A", "earthquake", 4, 10, 10, ["usgs", "gdacs"]), inc("B", "wildfire", 2, 10.5, 10.5, ["firms"]), inc("C", "flood", 3, 50, 50, ["gdacs"], "monitoring")],
    sources,
    scope: { label: "worldwide", name: "Worldwide", bbox: null },
    windowLabel: "7D",
    changes24h: { created: 2, escalated: 1 },
    now: new Date("2026-10-01T12:00:00Z"),
  });

  it("cites every sentence", () => {
    for (const p of r.paragraphs) for (const s of p.sentences) expect(s.cites.length).toBeGreaterThan(0);
    const max = Math.max(...r.paragraphs.flatMap((p) => p.sentences.flatMap((s) => s.cites)));
    expect(r.references).toHaveLength(max);
  });

  it("counts active and monitoring incidents and lists the most severe first", () => {
    expect(r.paragraphs[0]!.sentences[0]!.text).toContain("2 active incidents");
    expect(r.paragraphs[0]!.sentences[0]!.text).toContain("1 more under monitoring");
    const severe = r.paragraphs.find((p) => p.heading === "Most severe")!;
    expect(severe.sentences[0]!.text.startsWith("earthquake A")).toBe(true);
  });

  it("reports compound events and renders references", () => {
    expect(r.paragraphs.some((p) => p.heading === "Compound events")).toBe(true);
    const md = sitrepMarkdown(r, "7D");
    expect(md).toContain("## References");
    expect(md).toContain("USGS Earthquake Hazards Program");
    expect(md).toContain("Not an official alert");
  });

  it("limits to the view when a box is given", () => {
    const local = buildSitrep({
      incidents: [inc("A", "earthquake", 4, 10, 10, ["usgs"]), inc("Z", "earthquake", 4, -40, 100, ["usgs"])],
      sources,
      scope: { label: "in the current view", name: "Current view", bbox: [0, 0, 20, 20] },
      windowLabel: "7D",
      changes24h: { created: 0, escalated: 0 },
    });
    expect(local.paragraphs[0]!.sentences[0]!.text).toContain("1 active incident ");
  });
});
