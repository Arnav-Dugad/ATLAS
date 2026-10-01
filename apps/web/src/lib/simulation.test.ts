import { describe, expect, it } from "vitest";
import { mmi, radiusKm, sigma } from "./simulation";

// Reference values computed by the engine (services/engine/src/atlas/engine/simulation.py), so
// the public snapshot's in-browser scenario matches the local engine's.
describe("earthquake scenario (Allen, Wald & Worden 2012) — browser port matches the engine", () => {
  it("median intensity", () => {
    expect(mmi(5.0, 10)).toBeCloseTo(5.9736, 3);
    expect(mmi(6.5, 30)).toBeCloseTo(6.5388, 3);
    expect(mmi(7.3, 80)).toBeCloseTo(6.3593, 3);
    expect(mmi(8.0, 200)).toBeCloseTo(6.1603, 3);
  });

  it("uncertainty", () => {
    expect(sigma(5)).toBeCloseTo(1.1732, 3);
    expect(sigma(50)).toBeCloseTo(0.8842, 3);
  });

  it("band radii", () => {
    expect(radiusKm(6, 7.3, 10)).toBeCloseTo(105.94, 0);
    expect(radiusKm(8, 7.3, 10)).toBeCloseTo(10.75, 0);
    expect(radiusKm(5, 6.0, 15)).toBeCloseTo(54.49, 0);
    expect(radiusKm(9, 7.3, 10)).toBeNull();
  });
});
