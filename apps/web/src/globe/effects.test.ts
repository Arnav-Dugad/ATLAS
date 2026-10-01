import { describe, expect, it } from "vitest";
import { subsolarPoint, wavefrontDegrees } from "./effects";

describe("seismic wavefronts (IASP91 first arrivals)", () => {
  it("inverts the travel-time table", () => {
    expect(wavefrontDegrees("P", 143.7)).toBeCloseTo(10, 5);
    expect(wavefrontDegrees("P", 779.7)).toBeCloseTo(90, 5);
    expect(wavefrontDegrees("S", 1410)).toBeCloseTo(90, 5);
    expect(wavefrontDegrees("S", 100)).toBeGreaterThan(3);
    expect(wavefrontDegrees("S", 100)).toBeLessThan(5);
  });
  it("S always trails P, and both leave the globe", () => {
    for (const t of [30, 200, 600, 1000]) expect(wavefrontDegrees("S", t)!).toBeLessThan(wavefrontDegrees("P", t)!);
    expect(wavefrontDegrees("P", 1300)).toBeNull();
    expect(wavefrontDegrees("S", 1700)).toBeNull();
  });
});

describe("sub-solar point", () => {
  it("sits on the equator at the March equinox and on the Tropic of Cancer at the June solstice", () => {
    expect(Math.abs(subsolarPoint(Date.UTC(2026, 2, 20, 14, 46)).lat)).toBeLessThan(0.1);
    expect(subsolarPoint(Date.UTC(2026, 5, 21, 8, 24)).lat).toBeCloseTo(23.44, 1);
  });
  it("is near the Greenwich meridian at noon UTC (within the equation of time)", () => {
    expect(Math.abs(subsolarPoint(Date.UTC(2026, 3, 15, 12, 0)).lon)).toBeLessThan(4.5);
    // 2026-11-03 the equation of time is ~+16.4 min: the sun crosses Greenwich ~16 min before noon
    expect(subsolarPoint(Date.UTC(2026, 10, 3, 12, 0)).lon).toBeCloseTo(-4.1, 0);
  });
});
