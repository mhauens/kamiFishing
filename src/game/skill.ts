export type SkillCheckState = {
  targets: [number];
  hits: [boolean];
  errors: [number];
  missUntil: number;
};

export const SKILL_HIT_TOLERANCE = 0.052;
export const SKILL_CHECK_SPEED = 0.85;
export const SKILL_NEEDLE_HALF_WIDTH = 3 / 440;

export function createSkillCheckState(): SkillCheckState {
  return {
    targets: randomSkillTargets(),
    hits: [false],
    errors: [1],
    missUntil: 0
  };
}

export function randomSkillTargets(): [number] {
  return [0.18 + Math.random() * 0.68];
}

export function activeSkillTargetIndex(_state: SkillCheckState): 0 {
  return 0;
}

export function skillHitError(value: number, target: number): number {
  return Math.abs(value - target);
}

export function isSkillHit(value: number, target: number, tolerance = SKILL_HIT_TOLERANCE): boolean {
  return skillHitError(value, target) <= tolerance;
}

export function isVisibleSkillHit(value: number, target: number): boolean {
  return isSkillHit(value, target, SKILL_HIT_TOLERANCE + SKILL_NEEDLE_HALF_WIDTH);
}

export function isSkillSweepHit(previousValue: number, currentValue: number, target: number): boolean {
  const tolerance = SKILL_HIT_TOLERANCE + SKILL_NEEDLE_HALF_WIDTH;
  const minValue = Math.min(previousValue, currentValue);
  const maxValue = Math.max(previousValue, currentValue);
  return maxValue >= target - tolerance && minValue <= target + tolerance;
}

export function resetSkillCheck(state: SkillCheckState): void {
  state.hits = [false];
  state.errors = [1];
}

export function rerollSkillCheck(state: SkillCheckState): void {
  state.targets = randomSkillTargets();
  resetSkillCheck(state);
}
