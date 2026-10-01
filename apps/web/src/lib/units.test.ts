import { afterEach, describe, expect, it } from "vitest";
import { dist, metricValue, temperature, windSpeed } from "./format";
import { DEFAULT_UNITS, useSettings } from "./settings";

afterEach(() => useSettings.setState({ units: DEFAULT_UNITS }));

describe("display units", () => {
  it("leaves source units alone by default", () => {
    expect(dist(100)).toBe("100 km");
    expect(windSpeed(65)).toBe("65 kt");
    expect(temperature(31.24)).toBe("31.2 °C");
    expect(metricValue(65, "kt")).toBe("65 kt");
  });

  it("converts distance, wind and temperature for display only", () => {
    useSettings.getState().setUnits({ distance: "mi", wind: "mph", temperature: "F" });
    expect(dist(100)).toBe("62 mi");
    expect(windSpeed(65)).toBe("75 mph");
    expect(temperature(31.24)).toBe("88.2 °F");
    expect(metricValue(12.5, "km²")).toBe("4.8 mi²");
    useSettings.getState().setUnits({ wind: "kmh" });
    expect(windSpeed(65)).toBe("120 km/h");
    expect(metricValue(65, "kt")).toBe("120 km/h"); // ≥ 100 shows no decimals, as everywhere
  });
});
