export type Screen = "menu" | "game" | "results" | "highscores" | "settings";

export type UserSession = {
  authenticated: boolean;
  channelConnected: boolean;
  eventsubStatus?: string;
  user?: {
    id: string;
    login: string;
    displayName: string;
    picture?: string;
  };
};

export type GameSettings = {
  subsPerDuck: number;
  specialSubsPerDuck: number;
  guestDuckIntervalSeconds: number;
  twitchIdleDuckSeconds: number;
  duckEventPollSeconds: number;
};

export type GiftEvent = {
  id: string;
  at: number;
  displayName: string;
  total: number;
  anonymous: boolean;
};

export type DuckVariant = "normal" | "special";

export type Duck = {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  bob: number;
  movementPhase: number;
  name?: string;
  spriteIndex: number;
  variant: DuckVariant;
  catchableAt: number;
  caught: boolean;
  source: "guest" | "gift" | "idle" | "start";
};

export type RunMode = "guest" | "twitch";

export type CatchRecord = {
  id: string;
  name: string;
  spriteIndex: number;
  variant: DuckVariant;
  source: Duck["source"];
  caughtAt: number;
};

export type PendingGiftDuck = {
  eventId: string;
  name: string;
  total: number;
  variant: DuckVariant;
  announceEvent: boolean;
  eventHasSpecial: boolean;
};

export type SavedRun = {
  mode: RunMode;
  startedAt: number;
  score: number;
  caughtCount: number;
  seed: number;
  ducks: Duck[];
  catchHistory: CatchRecord[];
  catchCooldownUntil: number;
  lastGuestSpawnAt: number;
  lastGiftAt: number;
  lastDuckQuerySince: number;
  processedGiftIds: string[];
  pendingGiftDucks: PendingGiftDuck[];
  pendingReplacementAt?: number[];
};

export type HighscoreEntry = {
  id: string;
  score: number;
  caught: number;
  playedAt: number;
  displayName: string;
};
