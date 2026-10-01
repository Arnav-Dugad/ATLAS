import { describe, expect, it } from "vitest";
import { max24hGain, rapidIntensification } from "./cyclone";

const at = (h: number) => new Date(Date.UTC(2026, 8, 1) + h * 3_600_000).toISOString();

describe("rapid intensification", () => {
  it("flags a 35 kt gain in 24 h", () => {
    const r = max24hGain([0, 6, 12, 18, 24, 30].map((h, i) => ({ time: at(h), wind_kt: [45, 50, 60, 70, 80, 85][i] })));
    expect(r?.gainKt).toBe(35);
    expect(r?.rapid).toBe(true);
    expect(r?.from).toBe(at(0));
  });

  it("does not flag 25 kt", () => {
    const r = max24hGain([0, 12, 24].map((h, i) => ({ time: at(h), wind_kt: [50, 60, 75][i] })));
    expect(r?.rapid).toBe(false);
  });

  it("needs a full day of data", () => {
    expect(max24hGain([0, 6, 12].map((h) => ({ time: at(h), wind_kt: 50 + h * 5 })))).toBeNull();
  });

  it("keeps observed and forecast apart", () => {
    const track = [
      { time: at(0), wind_kt: 40, kind: "observed" as const },
      { time: at(12), wind_kt: 45, kind: "observed" as const },
      { time: at(24), wind_kt: 50, kind: "observed" as const },
      { time: at(36), wind_kt: 70, kind: "forecast" as const },
      { time: at(48), wind_kt: 85, kind: "forecast" as const },
    ];
    const r = rapidIntensification(track);
    expect(r.observed?.rapid).toBe(false);
    expect(r.forecast?.gainKt).toBe(35);
    expect(r.forecast?.rapid).toBe(true);
  });
});
