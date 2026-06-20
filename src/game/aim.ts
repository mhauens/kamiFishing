import { clampToWater, type Point } from "./water";

export type AimKeys = {
  left: boolean;
  right: boolean;
  up: boolean;
  down: boolean;
};

export function moveAimTarget(target: Point, keys: AimKeys, dt: number, speed = 430): Point {
  const xAxis = Number(keys.right) - Number(keys.left);
  const yAxis = Number(keys.down) - Number(keys.up);
  const length = Math.hypot(xAxis, yAxis);
  if (length === 0) return target;

  return clampToWater({
    x: target.x + (xAxis / length) * speed * dt,
    y: target.y + (yAxis / length) * speed * dt
  });
}

export function moveAimTowardGoal(target: Point, goal: Point, dt: number, elapsedSeconds: number): Point {
  const follow = 1 - Math.exp(-dt * 5.5);
  const driftX = Math.sin(elapsedSeconds * 3.1) * 10;
  const driftY = Math.cos(elapsedSeconds * 2.4) * 7;

  return clampToWater({
    x: target.x + (goal.x + driftX - target.x) * follow,
    y: target.y + (goal.y + driftY - target.y) * follow
  });
}
