import { describe, expect, it, vi } from "vitest";
import {
  SKILL_CHECK_SPEED,
  SKILL_HIT_TOLERANCE,
  SKILL_NEEDLE_HALF_WIDTH,
  activeSkillTargetIndex,
  createSkillCheckState,
  isSkillHit,
  isSkillSweepHit,
  isVisibleSkillHit,
  rerollSkillCheck,
  skillHitError
} from "./skill";

describe("skill check", () => {
  it("uses one active target", () => {
    const state = createSkillCheckState();
    expect(activeSkillTargetIndex(state)).toBe(0);
    expect(state.targets).toHaveLength(1);
  });

  it("uses a moderate success tolerance", () => {
    expect(isSkillHit(0.5, 0.5)).toBe(true);
    expect(isSkillHit(0.55, 0.5)).toBe(true);
    expect(isSkillHit(0.56, 0.5)).toBe(false);
    expect(SKILL_HIT_TOLERANCE).toBeGreaterThan(0.026);
    expect(skillHitError(0.47, 0.5)).toBeCloseTo(0.03);
  });

  it("counts the visible needle touching the success area", () => {
    expect(isVisibleSkillHit(0.557, 0.5)).toBe(true);
    expect(isVisibleSkillHit(0.56 + SKILL_NEEDLE_HALF_WIDTH, 0.5)).toBe(false);
  });

  it("counts a target crossed between visible frames", () => {
    expect(isSkillSweepHit(0.43, 0.56, 0.5)).toBe(true);
    expect(isSkillSweepHit(0.2, 0.3, 0.5)).toBe(false);
  });

  it("keeps the skill meter at a readable speed", () => {
    expect(SKILL_CHECK_SPEED).toBeLessThan(1);
  });

  it("rerolls targets after catches", () => {
    const random = vi.spyOn(Math, "random");
    random.mockReturnValueOnce(0.1);
    const state = createSkillCheckState();
    const firstTargets = [...state.targets];

    random.mockReturnValueOnce(0.8);
    state.hits = [true];
    rerollSkillCheck(state);

    expect(state.targets).not.toEqual(firstTargets);
    expect(state.hits).toEqual([false]);
    expect(state.errors).toEqual([1]);
    random.mockRestore();
  });
});
