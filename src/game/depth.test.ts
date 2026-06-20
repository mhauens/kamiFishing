import { describe, expect, it } from "vitest";
import { duckSizeForDepth, sortDucksBackToFront } from "./depth";

describe("sortDucksBackToFront", () => {
  it("draws higher ducks first so lower ducks cover them", () => {
    const ducks = [
      { id: "front", y: 820, bob: 0 },
      { id: "back", y: 560, bob: 0 },
      { id: "middle", y: 700, bob: 0 }
    ];

    expect(sortDucksBackToFront(ducks).map((duck) => duck.id)).toEqual(["back", "middle", "front"]);
  });

  it("draws rear ducks smaller than foreground ducks", () => {
    expect(duckSizeForDepth(500)).toBe(86);
    expect(duckSizeForDepth(940)).toBe(126);
    expect(duckSizeForDepth(700)).toBeGreaterThan(86);
  });
});
