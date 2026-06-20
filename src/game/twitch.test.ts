import { describe, expect, it } from "vitest";
import type { Duck, PendingTwitchDuck, TwitchParticipant } from "../types";
import {
  addUniqueParticipant,
  blockedTwitchUserIds,
  drawRaffleWinner,
  isDuckCommand
} from "./twitch";

const participants: TwitchParticipant[] = [
  { twitchUserId: "1", displayName: "Alpha" },
  { twitchUserId: "2", displayName: "Bravo" },
  { twitchUserId: "3", displayName: "Charlie" }
];

describe("!Ente command", () => {
  it("accepts case and outer whitespace but no extra text", () => {
    expect(isDuckCommand("!Ente")).toBe(true);
    expect(isDuckCommand("  !ENTE  ")).toBe(true);
    expect(isDuckCommand("!Ente bitte")).toBe(false);
    expect(isDuckCommand("Ente")).toBe(false);
  });

  it("keeps one entry per Twitch user in a round", () => {
    const first = addUniqueParticipant([], participants[0]);
    const duplicate = addUniqueParticipant(first, { twitchUserId: "1", displayName: "New Name" });
    expect(duplicate).toBe(first);
    expect(duplicate).toEqual([participants[0]]);
  });
});

describe("raffle winner selection", () => {
  it("draws only from users without an active or queued duck", () => {
    const activeDuck = { twitchUserId: "1", caught: false } as Duck;
    const queuedDuck = { twitchUserId: "2" } as PendingTwitchDuck;
    const blocked = blockedTwitchUserIds([activeDuck], [queuedDuck]);
    expect(drawRaffleWinner(participants, blocked, 0)).toEqual(participants[2]);
  });

  it("allows a user again after their duck is caught", () => {
    const caughtDuck = { twitchUserId: "1", caught: true } as Duck;
    const blocked = blockedTwitchUserIds([caughtDuck], []);
    expect(drawRaffleWinner(participants, blocked, 0)).toEqual(participants[0]);
  });

  it("returns null when everybody is blocked", () => {
    expect(drawRaffleWinner(participants, new Set(["1", "2", "3"]), 0.5)).toBeNull();
  });

  it("uses the random value across the eligible list", () => {
    expect(drawRaffleWinner(participants, new Set(), 0)).toEqual(participants[0]);
    expect(drawRaffleWinner(participants, new Set(), 0.5)).toEqual(participants[1]);
    expect(drawRaffleWinner(participants, new Set(), 0.999)).toEqual(participants[2]);
  });
});
