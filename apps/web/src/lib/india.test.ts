import { describe, expect, it } from "vitest";
import { seasonFor } from "./india";

describe("India seasons (IMD climatology)", () => {
  it("names the season for each part of the year", () => {
    expect(seasonFor(new Date(Date.UTC(2026, 6, 15))).season).toMatch(/Southwest monsoon/);
    expect(seasonFor(new Date(Date.UTC(2026, 9, 1))).season).toMatch(/Post-monsoon/);
    expect(seasonFor(new Date(Date.UTC(2026, 3, 20))).season).toMatch(/Pre-monsoon/);
    expect(seasonFor(new Date(Date.UTC(2026, 0, 10))).season).toMatch(/Winter/);
  });
});
