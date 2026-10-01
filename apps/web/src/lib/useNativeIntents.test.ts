import { beforeEach, describe, expect, it } from "vitest";
import { useSettings } from "./settings";
import { useUi } from "./store";
import { openLink } from "./useNativeIntents";
import { useWatch } from "./watch";

describe("atlas:// links", () => {
  beforeEach(() => {
    useUi.setState({ selectedId: null, story: null, paletteOpen: false });
    useWatch.setState({ panelOpen: false });
    useSettings.setState({ open: false });
  });

  it("opens an incident by id", () => {
    openLink("atlas://incident/ATL-EQ-2026-ABC123");
    expect(useUi.getState().selectedId).toBe("ATL-EQ-2026-ABC123");
  });

  it("ignores anything that is not an ATLAS incident id or another scheme", () => {
    openLink("atlas://incident/..%2F..%2Fsecret");
    openLink("atlas://incident/<script>");
    openLink("https://example.com/incident/ATL-EQ-2026-ABC123");
    expect(useUi.getState().selectedId).toBeNull();
  });

  it("runs app actions", () => {
    openLink("atlas://watch");
    expect(useWatch.getState().panelOpen).toBe(true);
    openLink("atlas://settings/packs");
    expect(useSettings.getState().open).toBe(true);
    expect(useSettings.getState().section).toBe("packs");
    openLink("atlas://search?q=tokyo");
    expect(useUi.getState().paletteOpen).toBe(true);
    expect(useUi.getState().paletteSeed).toBe("tokyo");
  });
});
