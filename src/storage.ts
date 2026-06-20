import type { GameSettings, HighscoreEntry, SavedRun, UserSession } from "./types";
import { sanitizeSettingsValue } from "./game/rules";

const RUN_KEY = "kamiFishing.activeRun";
const SETTINGS_KEY = "kamiFishing.settings";

const DEFAULT_SETTINGS: GameSettings = {
  subsPerDuck: 5,
  specialSubsPerDuck: 10,
  guestDuckIntervalSeconds: 12,
  twitchIdleDuckSeconds: 60,
  rewardCost: 1000,
  rewardCooldownSeconds: 10,
  rewardMaxPerUserPerStream: 1
};

export function loadSettings(): GameSettings {
  const raw = localStorage.getItem(SETTINGS_KEY);
  if (!raw) return DEFAULT_SETTINGS;

  try {
    const parsed = JSON.parse(raw) as Partial<GameSettings>;
    return normalizeSettings({ ...DEFAULT_SETTINGS, ...parsed });
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(settings: GameSettings): GameSettings {
  const normalized = normalizeSettings(settings);
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(normalized));
  return normalized;
}

export function normalizeSettings(settings: GameSettings): GameSettings {
  return {
    subsPerDuck: sanitizeSettingsValue(settings.subsPerDuck, 5, 1, 100),
    specialSubsPerDuck: sanitizeSettingsValue(settings.specialSubsPerDuck, 10, 1, 1000),
    guestDuckIntervalSeconds: sanitizeSettingsValue(settings.guestDuckIntervalSeconds, 12, 3, 120),
    twitchIdleDuckSeconds: sanitizeSettingsValue(settings.twitchIdleDuckSeconds, 60, 15, 900),
    rewardCost: sanitizeSettingsValue(settings.rewardCost, 1000, 1, 1_000_000),
    rewardCooldownSeconds: sanitizeSettingsValue(settings.rewardCooldownSeconds, 10, 0, 86_400),
    rewardMaxPerUserPerStream: sanitizeSettingsValue(settings.rewardMaxPerUserPerStream, 1, 0, 100)
  };
}

export function saveActiveRun(run: SavedRun): void {
  sessionStorage.setItem(RUN_KEY, JSON.stringify(run));
}

export function loadActiveRun(): SavedRun | null {
  const raw = sessionStorage.getItem(RUN_KEY);
  if (!raw) return null;

  try {
    return JSON.parse(raw) as SavedRun;
  } catch {
    clearActiveRun();
    return null;
  }
}

export function clearActiveRun(): void {
  sessionStorage.removeItem(RUN_KEY);
}

export function highscoreKey(session: UserSession): string | null {
  if (!session.authenticated || !session.user) return null;
  return `kamiFishing.highscores.${session.user.id}`;
}

export function loadHighscores(session: UserSession): HighscoreEntry[] {
  const key = highscoreKey(session);
  if (!key) return [];

  const raw = localStorage.getItem(key);
  if (!raw) return [];

  try {
    return (JSON.parse(raw) as HighscoreEntry[]).sort((a, b) => b.score - a.score).slice(0, 20);
  } catch {
    localStorage.removeItem(key);
    return [];
  }
}

export function addHighscore(session: UserSession, entry: Omit<HighscoreEntry, "id" | "displayName">): HighscoreEntry | null {
  const key = highscoreKey(session);
  if (!key || !session.user) return null;

  const nextEntry: HighscoreEntry = {
    ...entry,
    id: crypto.randomUUID(),
    displayName: session.user.displayName
  };
  const entries = [...loadHighscores(session), nextEntry].sort((a, b) => b.score - a.score).slice(0, 20);
  localStorage.setItem(key, JSON.stringify(entries));
  return nextEntry;
}
