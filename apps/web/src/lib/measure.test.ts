import { describe, expect, it } from "vitest";
import { areaKm2, bearingDeg, haversineKm, pathKm, toGeoJSON, useMeasure } from "./measure";

describe("measure geometry", () => {
  it("measures great-circle distance", () => {
    // Delhi → Mumbai, ~1,150 km by great circle
    const d = haversineKm({ lat: 28.6139, lon: 77.209 }, { lat: 19.076, lon: 72.8777 });
    expect(d).toBeGreaterThan(1140);
    expect(d).toBeLessThan(1160);
  });

  it("closes a path only when asked", () => {
    const sq = [
      { lat: 0, lon: 0 },
      { lat: 0, lon: 1 },
      { lat: 1, lon: 1 },
    ];
    expect(pathKm(sq, true)).toBeGreaterThan(pathKm(sq));
  });

  it("matches the engine's area for a 1° square at the equator", () => {
    const a = areaKm2([
      { lat: 0, lon: 0 },
      { lat: 0, lon: 1 },
      { lat: 1, lon: 1 },
      { lat: 1, lon: 0 },
    ]);
    expect(a).toBeGreaterThan(12_300);
    expect(a).toBeLessThan(12_400);
  });

  it("handles areas across the antimeridian", () => {
    const a = areaKm2([
      { lat: 0, lon: 179.5 },
      { lat: 0, lon: -179.5 },
      { lat: 1, lon: -179.5 },
      { lat: 1, lon: 179.5 },
    ]);
    expect(a).toBeGreaterThan(12_300);
    expect(a).toBeLessThan(12_400);
  });

  it("gives bearings clockwise from north", () => {
    expect(Math.round(bearingDeg({ lat: 0, lon: 0 }, { lat: 1, lon: 0 }))).toBe(0);
    expect(Math.round(bearingDeg({ lat: 0, lon: 0 }, { lat: 0, lon: 1 }))).toBe(90);
  });

  it("exports closed polygons as GeoJSON", () => {
    const g = JSON.parse(
      toGeoJSON(
        [
          { lat: 0, lon: 0 },
          { lat: 0, lon: 1 },
          { lat: 1, lon: 1 },
        ],
        "area",
      ),
    );
    expect(g.geometry.type).toBe("Polygon");
    expect(g.geometry.coordinates[0]).toHaveLength(4);
  });

  it("only adds points while drawing", () => {
    const m = useMeasure.getState();
    m.start("distance", { lat: 1, lon: 2 });
    useMeasure.getState().add({ lat: 3, lon: 4 });
    useMeasure.getState().setDrawing(false);
    useMeasure.getState().add({ lat: 5, lon: 6 });
    expect(useMeasure.getState().points).toHaveLength(2);
    useMeasure.getState().stop();
    expect(useMeasure.getState().points).toHaveLength(0);
  });
});

describe("sundial time", () => {
  it("includes the equation of time (sundial runs ~10 min fast in early October)", async () => {
    const { apparentSolarHour } = await import("./sun");
    const t = Date.UTC(2026, 9, 1, 12, 0, 0);
    const minutes = (apparentSolarHour(0, t) - 12) * 60;
    expect(minutes).toBeGreaterThan(9);
    expect(minutes).toBeLessThan(11.5);
  });
});
