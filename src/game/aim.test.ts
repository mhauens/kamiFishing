import { describe, expect, it } from "vitest";
import { isWaterPoint } from "./water";
import { moveAimTarget, moveAimTowardGoal } from "./aim";

describe("moveAimTarget", () => {
  it("moves the target with normalized keyboard input", () => {
    const moved = moveAimTarget({ x: 820, y: 720 }, { left: false, right: true, up: false, down: false }, 1, 100);

    expect(moved.x).toBeGreaterThan(820);
    expect(moved.y).toBe(720);
  });

  it("keeps the target in water when pushed toward shore", () => {
    const moved = moveAimTarget({ x: 260, y: 620 }, { left: true, right: false, up: true, down: false }, 1, 900);

    expect(isWaterPoint(moved)).toBe(true);
  });
});

describe("moveAimTowardGoal", () => {
  it("eases toward the mouse goal instead of snapping", () => {
    const moved = moveAimTowardGoal({ x: 820, y: 720 }, { x: 1120, y: 720 }, 0.016, 1);

    expect(moved.x).toBeGreaterThan(820);
    expect(moved.x).toBeLessThan(1120);
    expect(isWaterPoint(moved)).toBe(true);
  });
});
