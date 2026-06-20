import type { Duck } from "../types";

export function duckDepth(duck: Pick<Duck, "y" | "bob">): number {
  return duck.y + Math.sin(duck.bob) * 6;
}

export function sortDucksBackToFront<T extends Pick<Duck, "y" | "bob">>(ducks: T[]): T[] {
  return [...ducks].sort((left, right) => duckDepth(left) - duckDepth(right));
}

export function duckSizeForDepth(y: number): number {
  const depth = Math.min(1, Math.max(0, (y - 500) / 440));
  return 86 + depth * 40;
}
