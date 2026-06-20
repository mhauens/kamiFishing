import type { DuckVariant, GiftEvent, PendingGiftDuck, RunMode } from "../types";

export const GUEST_SPECIAL_CHANCE = 0.1;
export const TWITCH_IDLE_SPECIAL_CHANCE = 0.05;
export const SPECIAL_GIFT_SUB_THRESHOLD = 10;
export const CATCH_COOLDOWN_MS = 10_000;
export const CATCH_REPLACEMENT_DELAY_MS = 60_000;
export const NEW_DUCK_CATCHABLE_DELAY_MS = 50_000;
export const SPECIAL_DUCK_SPEED_MULTIPLIER = 1.35;
export const MAX_ACTIVE_DUCKS = 20;

export type DuckSpawnInstruction = {
  source: "gift";
  name: string;
  eventId: string;
  copy: number;
  variant: DuckVariant;
};

export function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function sanitizeSettingsValue(value: number, fallback: number, min: number, max: number): number {
  return clampNumber(Math.round(value || fallback), min, max);
}

export function duckSpawnsFromGiftEvent(event: GiftEvent, subsPerDuck: number): DuckSpawnInstruction[] {
  const threshold = sanitizeSettingsValue(subsPerDuck, 5, 1, 100);
  const total = Math.max(0, event.total);
  const specialCopies = Math.floor(total / SPECIAL_GIFT_SUB_THRESHOLD);
  const remainingSubs = total - specialCopies * SPECIAL_GIFT_SUB_THRESHOLD;
  const normalCopies = Math.floor(remainingSubs / threshold);
  const name = event.anonymous ? "Anonymous" : event.displayName.trim() || "Anonymous";

  const specialSpawns = Array.from({ length: specialCopies }, (_, index) => ({
    source: "gift" as const,
    name,
    eventId: event.id,
    copy: index + 1,
    variant: "special" as const
  }));

  const normalSpawns = Array.from({ length: normalCopies }, (_, index) => ({
    source: "gift" as const,
    name,
    eventId: event.id,
    copy: specialCopies + index + 1,
    variant: "normal" as const
  }));

  return [...specialSpawns, ...normalSpawns];
}

export function pendingGiftDucksFromEvent(event: GiftEvent, subsPerDuck: number): PendingGiftDuck[] {
  const spawns = duckSpawnsFromGiftEvent(event, subsPerDuck);
  const eventHasSpecial = spawns.some((spawn) => spawn.variant === "special");

  return spawns.map((spawn, index) => ({
    eventId: event.id,
    name: spawn.name,
    total: event.total,
    variant: spawn.variant,
    announceEvent: index === 0,
    eventHasSpecial
  }));
}

export function chooseDuckVariant(specialChance: number, randomValue = Math.random()): DuckVariant {
  return randomValue < clampNumber(specialChance, 0, 1) ? "special" : "normal";
}

export function catchReplacementSpecialChance(mode: RunMode): number {
  return mode === "guest" ? GUEST_SPECIAL_CHANCE : TWITCH_IDLE_SPECIAL_CHANCE;
}

export function isDuckCatchable(catchableAt: number, now: number): boolean {
  return now >= catchableAt;
}

export function duckSpeedForVariant(baseSpeed: number, variant: DuckVariant): number {
  return variant === "special" ? baseSpeed * SPECIAL_DUCK_SPEED_MULTIPLIER : baseSpeed;
}

export function giftBannerText(name: string, total: number, hasSpecial: boolean): string {
  return hasSpecial ? `${name} gifted ${total} subs! SPECIAL DUCK incoming!` : `${name} gifted ${total} subs! Duck incoming!`;
}

export function canSpawnDuck(activeDuckCount: number, maxActiveDucks = MAX_ACTIVE_DUCKS): boolean {
  return activeDuckCount < maxActiveDucks;
}

export function shouldSpawnIdleDuck(now: number, lastGiftAt: number, idleSeconds: number): boolean {
  const idleMs = sanitizeSettingsValue(idleSeconds, 60, 15, 900) * 1000;
  return now - lastGiftAt >= idleMs;
}

export function formatTime(seconds: number): string {
  const safe = Math.max(0, Math.ceil(seconds));
  const mins = Math.floor(safe / 60).toString().padStart(2, "0");
  const secs = (safe % 60).toString().padStart(2, "0");
  return `${mins}:${secs}`;
}
