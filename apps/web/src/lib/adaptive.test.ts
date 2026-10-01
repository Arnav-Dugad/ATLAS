import { describe, expect, it } from "vitest";
import { MIN_SCALE, nextScale } from "./adaptive";

describe("adaptive resolution", () => {
  it("drops quickly when frames are slow and never below the floor", () => {
    let s = { scale: 1, goodWindows: 0 };
    s = nextScale(s, 40, 1000 / 18, 60);
    expect(s.scale).toBe(0.85);
    for (let i = 0; i < 10; i++) s = nextScale(s, 40, 1000 / 10, 60);
    expect(s.scale).toBe(MIN_SCALE);
  });

  it("recovers only after three good windows in a row", () => {
    let s = { scale: 0.7, goodWindows: 0 };
    s = nextScale(s, 120, 1000 / 60, 60);
    s = nextScale(s, 120, 1000 / 60, 60);
    expect(s.scale).toBe(0.7);
    s = nextScale(s, 120, 1000 / 60, 60);
    expect(s.scale).toBe(0.8);
  });

  it("ignores windows without continuous animation", () => {
    expect(nextScale({ scale: 1, goodWindows: 0 }, 3, 600, 60)).toEqual({ scale: 1, goodWindows: 0 });
  });

  it("judges a 30 fps battery-saver target against its own rate", () => {
    expect(nextScale({ scale: 1, goodWindows: 0 }, 60, 1000 / 28, 30).scale).toBe(1);
  });
});
