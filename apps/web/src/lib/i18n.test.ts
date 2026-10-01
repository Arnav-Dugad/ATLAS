import { afterEach, describe, expect, it } from "vitest";
import { hazardMeta } from "./hazards";
import { t } from "./i18n";
import { useSettings } from "./settings";

describe("interface language", () => {
  afterEach(() => useSettings.getState().setLang("en"));

  it("returns English unchanged and translates known strings in Hindi", () => {
    expect(t("Planet")).toBe("Planet");
    useSettings.getState().setLang("hi");
    expect(t("Planet")).toBe("पृथ्वी");
    expect(t("A string nobody translated")).toBe("A string nobody translated");
  });

  it("translates hazard names without touching ids or colours", () => {
    useSettings.getState().setLang("hi");
    const m = hazardMeta("earthquake");
    expect(m.label).toBe("भूकंप");
    expect(m.id).toBe("earthquake");
    useSettings.getState().setLang("en");
    expect(hazardMeta("earthquake").label).toBe("Earthquake");
  });
});
