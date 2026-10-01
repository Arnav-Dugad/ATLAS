import { describe, expect, it } from "vitest";
import { compoundGroups } from "./compound";

const inc = (id: string, hazard: string, lat: number, lon: number, level = 3) => ({
  id,
  hazard,
  lat,
  lon,
  status: "active",
  severity: { level },
  title: id,
});

describe("compound events", () => {
  it("groups different hazards within 300 km", () => {
    const groups = compoundGroups([inc("fire", "wildfire", 10, 10), inc("storm", "tropical_cyclone", 11, 11, 4), inc("far", "earthquake", 40, 40)]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.hazards.sort()).toEqual(["tropical_cyclone", "wildfire"]);
    expect(groups[0]!.lead.id).toBe("storm");
  });

  it("never forms a group from one hazard type alone", () => {
    expect(compoundGroups([inc("a", "wildfire", 10, 10), inc("b", "wildfire", 10.1, 10.1)])).toHaveLength(0);
  });

  it("chains through different hazards only", () => {
    // two fires near one earthquake end up together
    const groups = compoundGroups([inc("f1", "wildfire", 0, 0), inc("eq", "earthquake", 0, 2), inc("f2", "wildfire", 0, 4)]);
    expect(groups[0]!.members.map((m) => m.id).sort()).toEqual(["eq", "f1", "f2"]);
  });
});
