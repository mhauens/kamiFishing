import { describe, expect, it } from "vitest";
import {
  CATCH_COOLDOWN_MS,
  CATCH_REPLACEMENT_DELAY_MS,
  GUEST_SPECIAL_CHANCE,
  MAX_ACTIVE_DUCKS,
  NEW_DUCK_CATCHABLE_DELAY_MS,
  SPECIAL_DUCK_SPEED_MULTIPLIER,
  TWITCH_IDLE_SPECIAL_CHANCE,
  canSpawnDuck,
  catchReplacementSpecialChance,
  chooseDuckVariant,
  duckSpeedForVariant,
  duckSpawnsFromGiftEvent,
  formatTime,
  giftBannerText,
  isDuckCatchable,
  pendingGiftDucksFromEvent,
  shouldSpawnIdleDuck
} from "./rules";
import type { GiftEvent } from "../types";

function gift(total: number, overrides: Partial<GiftEvent> = {}): GiftEvent {
  return {
    id: "evt-1",
    at: 1000,
    displayName: "Kami",
    total,
    anonymous: false,
    ...overrides
  };
}

describe("duckSpawnsFromGiftEvent", () => {
  it("does not spawn below threshold", () => {
    expect(duckSpawnsFromGiftEvent(gift(4), 5)).toHaveLength(0);
  });

  it("spawns one duck at threshold", () => {
    expect(duckSpawnsFromGiftEvent(gift(5), 5)).toEqual([
      { source: "gift", name: "Kami", eventId: "evt-1", copy: 1, variant: "normal" }
    ]);
  });

  it("turns ten-sub bundles into special ducks before remaining normal ducks", () => {
    expect(duckSpawnsFromGiftEvent(gift(10), 5)).toEqual([
      { source: "gift", name: "Kami", eventId: "evt-1", copy: 1, variant: "special" }
    ]);
    expect(duckSpawnsFromGiftEvent(gift(15), 5).map((spawn) => spawn.variant)).toEqual(["special", "normal"]);
    expect(duckSpawnsFromGiftEvent(gift(20), 5).map((spawn) => spawn.variant)).toEqual(["special", "special"]);
    expect(duckSpawnsFromGiftEvent(gift(25), 5).map((spawn) => spawn.variant)).toEqual(["special", "special", "normal"]);
  });

  it("uses Anonymous for anonymous gifts", () => {
    expect(duckSpawnsFromGiftEvent(gift(10, { anonymous: true, displayName: "" }), 5).every((spawn) => spawn.name === "Anonymous")).toBe(
      true
    );
  });
});

describe("chooseDuckVariant", () => {
  it("uses the guest special chance boundary", () => {
    expect(chooseDuckVariant(GUEST_SPECIAL_CHANCE, 0.099)).toBe("special");
    expect(chooseDuckVariant(GUEST_SPECIAL_CHANCE, 0.1)).toBe("normal");
  });

  it("uses the twitch idle special chance boundary", () => {
    expect(chooseDuckVariant(TWITCH_IDLE_SPECIAL_CHANCE, 0.049)).toBe("special");
    expect(chooseDuckVariant(TWITCH_IDLE_SPECIAL_CHANCE, 0.05)).toBe("normal");
  });

  it("uses mode chances for catch replacement ducks", () => {
    expect(catchReplacementSpecialChance("guest")).toBe(GUEST_SPECIAL_CHANCE);
    expect(catchReplacementSpecialChance("twitch")).toBe(TWITCH_IDLE_SPECIAL_CHANCE);
  });
});

describe("catch timing constants", () => {
  it("uses the configured cooldown and fresh duck protection durations", () => {
    expect(CATCH_COOLDOWN_MS).toBe(10_000);
    expect(CATCH_REPLACEMENT_DELAY_MS).toBe(60_000);
    expect(NEW_DUCK_CATCHABLE_DELAY_MS).toBe(50_000);
    expect(SPECIAL_DUCK_SPEED_MULTIPLIER).toBeCloseTo(1.35);
  });

  it("blocks newly spawned ducks until catchableAt", () => {
    expect(isDuckCatchable(50_000, 49_999)).toBe(false);
    expect(isDuckCatchable(50_000, 50_000)).toBe(true);
  });

  it("keeps special ducks faster than normal ducks", () => {
    expect(duckSpeedForVariant(20, "normal")).toBe(20);
    expect(duckSpeedForVariant(20, "special")).toBeCloseTo(27);
  });
});

describe("giftBannerText", () => {
  it("describes normal and special gift events", () => {
    expect(giftBannerText("Kami", 5, false)).toBe("Kami gifted 5 subs! Duck incoming!");
    expect(giftBannerText("Kami", 10, true)).toBe("Kami gifted 10 subs! SPECIAL DUCK incoming!");
  });
});

describe("active duck capacity", () => {
  it("allows spawns only below the simultaneous duck limit", () => {
    expect(MAX_ACTIVE_DUCKS).toBe(20);
    expect(canSpawnDuck(19)).toBe(true);
    expect(canSpawnDuck(20)).toBe(false);
    expect(canSpawnDuck(21)).toBe(false);
  });

  it("keeps every gift duck in FIFO queue form when the pond is full", () => {
    const queued = pendingGiftDucksFromEvent(gift(25), 5);
    expect(queued.map((duck) => duck.variant)).toEqual(["special", "special", "normal"]);
    expect(queued).toHaveLength(3);
    expect(queued.map((duck) => duck.announceEvent)).toEqual([true, false, false]);
  });
});

describe("shouldSpawnIdleDuck", () => {
  it("waits until the configured timeout", () => {
    expect(shouldSpawnIdleDuck(30_000, 0, 60)).toBe(false);
    expect(shouldSpawnIdleDuck(60_000, 0, 60)).toBe(true);
  });
});

describe("formatTime", () => {
  it("formats countdown values", () => {
    expect(formatTime(90)).toBe("01:30");
    expect(formatTime(3.2)).toBe("00:04");
    expect(formatTime(-1)).toBe("00:00");
  });
});
