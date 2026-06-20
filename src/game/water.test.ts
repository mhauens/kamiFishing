import { describe, expect, it } from "vitest";
import { clampToWater, isDuckWaterPoint, isWaterPoint, moveDuckWithinWater, randomDuckWaterPoint, moveWithinWater, randomWaterPoint } from "./water";

describe("water mask", () => {
  it("rejects obvious shore, hedge, and dock points", () => {
    expect(isWaterPoint({ x: 520, y: 390 })).toBe(false);
    expect(isWaterPoint({ x: 1500, y: 585 })).toBe(false);
    expect(isWaterPoint({ x: 1710, y: 780 })).toBe(false);
  });

  it("accepts central water points", () => {
    expect(isWaterPoint({ x: 780, y: 720 })).toBe(true);
    expect(isWaterPoint({ x: 1080, y: 820 })).toBe(true);
  });

  it("spawns ducks only in water", () => {
    for (let index = 0; index < 100; index += 1) {
      expect(isWaterPoint(randomWaterPoint())).toBe(true);
    }
  });

  it("spawns duck sprites with enough visual clearance", () => {
    for (let index = 0; index < 100; index += 1) {
      expect(isDuckWaterPoint(randomDuckWaterPoint())).toBe(true);
    }
  });

  it("rejects duck sprite anchors too close to the shore and dock", () => {
    expect(isDuckWaterPoint({ x: 310, y: 510 })).toBe(false);
    expect(isDuckWaterPoint({ x: 1500, y: 700 })).toBe(false);
    expect(isDuckWaterPoint({ x: 1250, y: 910 })).toBe(false);
  });

  it("clamps cast targets back into water", () => {
    expect(isWaterPoint(clampToWater({ x: 1500, y: 585 }))).toBe(true);
    expect(isWaterPoint(clampToWater({ x: 520, y: 390 }))).toBe(true);
  });

  it("keeps moving ducks inside water", () => {
    const duck = { x: 780, y: 720, vx: -900, vy: -700 };
    moveWithinWater(duck, 1);
    expect(isWaterPoint(duck)).toBe(true);
  });

  it("keeps moving duck sprites visually inside water", () => {
    const duck = { x: 780, y: 720, vx: -900, vy: -700 };
    moveDuckWithinWater(duck, 1);
    expect(isDuckWaterPoint(duck)).toBe(true);
  });
});
