import { describe, expect, it } from "vitest";
import { rank, useUi } from "./store";

describe("overlay stacking", () => {
  it("moves an overlay above or below its visible neighbour", () => {
    useUi.setState({ overlayOrder: [] });
    const visible = ["imagery.truecolor", "imagery.precip", "imagery.sst"];
    const sorted = () => [...visible].sort((a, b) => rank(useUi.getState().overlayOrder, a) - rank(useUi.getState().overlayOrder, b));
    expect(sorted()).toEqual(visible); // catalogue order by default
    useUi.getState().moveOverlay("imagery.truecolor", 1, visible);
    expect(sorted()).toEqual(["imagery.precip", "imagery.truecolor", "imagery.sst"]);
    useUi.getState().moveOverlay("imagery.sst", -1, visible);
    expect(sorted()).toEqual(["imagery.precip", "imagery.sst", "imagery.truecolor"]);
    useUi.getState().moveOverlay("imagery.truecolor", 1, visible); // already on top: no change
    expect(sorted()).toEqual(["imagery.precip", "imagery.sst", "imagery.truecolor"]);
  });

  it("clamps opacity", () => {
    useUi.getState().setOverlayOpacity("imagery.sst", 0);
    expect(useUi.getState().overlayOpacity["imagery.sst"]).toBe(0.1);
    useUi.getState().setOverlayOpacity("imagery.sst", 2);
    expect(useUi.getState().overlayOpacity["imagery.sst"]).toBe(1);
  });
});
