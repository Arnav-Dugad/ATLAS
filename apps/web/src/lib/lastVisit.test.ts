import { describe, expect, it } from "vitest";
import { summarise } from "./lastVisit";

describe("since your last visit", () => {
  it("groups new, escalated and ended incidents without double counting", () => {
    const s = summarise([
      { kind: "created", incident_id: "A", significance: 2 },
      { kind: "severity_changed", incident_id: "A", significance: 3, summary: "Severity raised Moderate → Severe" },
      { kind: "severity_changed", incident_id: "B", significance: 3, summary: "Severity raised Moderate → Severe" },
      { kind: "severity_changed", incident_id: "C", significance: 2, summary: "Severity lowered Severe → Moderate" },
      { kind: "status_changed", incident_id: "D", significance: 1, summary: "Status monitoring → closed" },
    ]);
    expect(s.created).toEqual(["A"]);
    expect(s.escalated).toEqual(["B"]);
    expect(s.ended).toEqual(["D"]);
  });
});
