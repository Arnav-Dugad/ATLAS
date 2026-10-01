import { describe, expect, it } from "vitest";
import { isIntegratedGpu } from "./settings";

const angle = (name: string) => `ANGLE (Vendor, ${name} (0x00001234) Direct3D11 vs_5_0 ps_5_0, D3D11)`;

describe("graphics classification for Automatic quality", () => {
  it("recognises integrated graphics", () => {
    expect(isIntegratedGpu(angle("Intel(R) UHD Graphics"))).toBe(true);
    expect(isIntegratedGpu(angle("Intel(R) Iris(R) Xe Graphics"))).toBe(true);
    expect(isIntegratedGpu(angle("AMD Radeon(TM) Graphics"))).toBe(true);
  });

  it("recognises dedicated GPUs", () => {
    expect(isIntegratedGpu(angle("NVIDIA GeForce RTX 4060 Laptop GPU"))).toBe(false);
    expect(isIntegratedGpu(angle("AMD Radeon RX 7600"))).toBe(false);
    expect(isIntegratedGpu(angle("Intel(R) Arc(TM) A770 Graphics"))).toBe(false);
  });
});
