import { describe, expect, it } from "vitest";
import { filterIncidents, type IncidentDetail, type IncidentList, type IncidentSummary } from "./api";
import { briefMarkdown } from "./export";
import { compact, coord, metricValue, relTime, utcFull, utcShort } from "./format";
import { fuzzy } from "./fuzzy";
import { HAZARDS, hazardMeta, severityColor } from "./hazards";

describe("fuzzy", () => {
  it("prefers prefix and word-start matches", () => {
    const a = fuzzy("tok", "Tokyo")!;
    const b = fuzzy("tok", "Hitokyo")!;
    expect(a.score).toBeGreaterThan(b.score);
    expect(a.indices).toEqual([0, 1, 2]);
  });
  it("matches subsequences and rejects non-matches", () => {
    expect(fuzzy("shw eq", "Show only earthquakes")).not.toBeNull();
    expect(fuzzy("xyz", "Show only earthquakes")).toBeNull();
  });
});

describe("format", () => {
  it("formats coordinates with hemispheres", () => {
    expect(coord(19.2, -108.5)).toBe("19.20°N 108.50°W");
    expect(coord(null, 3)).toBe("—");
  });
  it("formats UTC times", () => {
    expect(utcShort("2026-10-01T03:04:00Z")).toBe("01 Oct 03:04Z");
    expect(utcFull("2026-10-01T03:04:05Z")).toBe("2026-10-01 03:04:05 UTC");
  });
  it("formats relative ages", () => {
    const now = Date.parse("2026-10-01T12:00:00Z");
    expect(relTime("2026-10-01T11:58:00Z", now)).toBe("2m ago");
    expect(relTime("2026-09-29T12:00:00Z", now)).toBe("2d ago");
    expect(relTime("2026-10-01T12:30:00Z", now)).toBe("in 30m");
  });
  it("never shows fake precision", () => {
    expect(metricValue(80)).toBe("80");
    expect(metricValue(6.62, "M")).toBe("6.6 M");
    expect(metricValue(null)).toBe("—");
    expect(compact(116_600)).toBe("116.6K");
  });
});

describe("hazards", () => {
  it("gives every hazard a distinct glyph (meaning never colour-only)", () => {
    const glyphs = Object.values(HAZARDS).map((h) => h.glyph);
    expect(new Set(glyphs).size).toBe(glyphs.length);
  });
  it("falls back safely", () => {
    expect(hazardMeta("unknown-thing").id).toBe("other");
    expect(severityColor(9)).toBe(severityColor(5));
  });
});

describe("brief export", () => {
  it("includes provenance, limitations and attribution", () => {
    const d = {
      id: "ATL-EQ-2026-TEST0001",
      title: "M6.6 earthquake — 80 km ENE of Tadine, New Caledonia",
      hazard: "earthquake",
      hazard_label: "Earthquake",
      status: "active",
      lat: -21.2,
      lon: 168.6,
      started_at: "2026-09-30T21:02:11Z",
      last_observation_at: "2026-09-30T22:00:00Z",
      severity: { level: 3, label: "Significant", basis: "M6.6 (USGS) → magnitude band 3", method: "atlas-severity-v1.1" },
      confidence: { score: 0.82, label: "high", method: "atlas-confidence-heuristic-v1", components: [], note: "" },
      headline: [{ key: "magnitude", label: "Magnitude", value: 6.6, unit: "mww", provenance: "real", source: "usgs" }],
      changes: [],
      official_links: [{ label: "USGS event page", url: "https://earthquake.usgs.gov/", authority: "USGS" }],
      limitations: ["Automatic solutions are revised."],
      citations: [{ name: "USGS", license: "Public domain", attribution: "Earthquake data: U.S. Geological Survey (USGS)" }],
      place: { description: "80 km ENE of Tadine, New Caledonia" },
      country_name: "New Caledonia",
    } as unknown as IncidentDetail;
    const md = briefMarkdown(d);
    expect(md).toContain("ATLAS INCIDENT BRIEF");
    expect(md).toContain("| Magnitude | 6.6 mww | Observed | usgs |");
    expect(md).toContain("Earthquake data: U.S. Geological Survey (USGS)");
    expect(md).toContain("Not an official alert");
  });
});

describe("filterIncidents (snapshot mode)", () => {
  const inc = (id: string, status: string, hazard: string, level: number, at: string) =>
    ({ id, status, hazard, severity: { level }, last_observation_at: at }) as unknown as IncidentSummary;
  const list: IncidentList = {
    total: 4,
    generated_at: "2026-10-01T12:00:00Z",
    items: [
      inc("a", "active", "earthquake", 2, "2026-10-01T11:00:00Z"),
      inc("b", "active", "wildfire", 4, "2026-09-30T08:00:00Z"),
      inc("c", "closed", "earthquake", 5, "2026-10-01T10:00:00Z"),
      inc("d", "monitoring", "volcano", 1, "2026-09-20T00:00:00Z"),
    ],
  };

  it("applies status, hazard and time filters like the engine", () => {
    const q = new URLSearchParams({ status: "active,monitoring", since: "2026-09-29T00:00:00Z" });
    expect(filterIncidents(list, q).items.map((i) => i.id)).toEqual(["b", "a"]);
    expect(filterIncidents(list, new URLSearchParams({ hazard: "earthquake" })).total).toBe(2);
  });

  it("sorts by recency when asked and honours the limit", () => {
    const out = filterIncidents(list, new URLSearchParams({ sort: "recent", limit: "2" }));
    expect(out.items.map((i) => i.id)).toEqual(["a", "c"]);
    expect(out.total).toBe(4);
  });
});
