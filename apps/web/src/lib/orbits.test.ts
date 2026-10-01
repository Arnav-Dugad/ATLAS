import { describe, expect, it } from "vitest";
import { groundTrack, loadSatellites, nextOverpasses } from "./orbits";

// Real CelesTrak element sets fetched 2026-10-01 (epochs 26274.x = 1 October 2026).
const TLES = loadSatellites([
  { name: "SENTINEL-2A", norad: 40697, mission: "Sentinel-2", swath_km: 290, line1: "1 40697U 15028A   26274.29857647 -.00000002  00000+0  15863-4 0  9990", line2: "2 40697  98.5653 347.6046 0001070  85.9280 274.2026 14.30818852588907" },
  { name: "SENTINEL-2B", norad: 42063, mission: "Sentinel-2", swath_km: 290, line1: "1 42063U 17013A   26274.29142365 -.00000116  00000+0 -27532-4 0  9992", line2: "2 42063  98.5698 347.5416 0001144  87.9623 272.1691 14.30816959499812" },
  { name: "SENTINEL-2C", norad: 60989, mission: "Sentinel-2", swath_km: 290, line1: "1 60989U 24157A   26273.97675974  .00000041  00000+0  32245-4 0  9999", line2: "2 60989  98.5706 347.2366 0001210  82.3430 277.7890 14.30816519108113" },
]);
const FROM = Date.UTC(2026, 9, 1, 12, 0);

describe("Sentinel-2 overpasses from real orbits", () => {
  it("propagates every satellite", () => {
    expect(TLES).toHaveLength(3);
    const track = groundTrack(TLES[0]!, new Date(FROM), 100, 60);
    expect(track.length).toBeGreaterThan(90);
    // sun-synchronous at 98.6° inclination: the track reaches ~81° latitude
    expect(Math.max(...track.map((p) => Math.abs(p.lat)))).toBeGreaterThan(78);
  });

  it("finds daylight passes over Delhi in mid-morning local solar time", () => {
    // each satellite repeats its ground track every 10 days, so three satellites give about
    // three passes in ten days at this latitude (verified against the elements above)
    const passes = nextOverpasses(TLES, 28.61, 77.21, FROM, 10);
    expect(passes.map((p) => p.satellite)).toEqual(["SENTINEL-2A", "SENTINEL-2B", "SENTINEL-2C"]);
    for (const p of passes) {
      expect(p.offTrackKm).toBeLessThanOrEqual(145);
      expect(p.localSolarHour).toBeGreaterThan(9.5);
      expect(p.localSolarHour).toBeLessThan(11.5);
    }
  });
});
