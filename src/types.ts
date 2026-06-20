export type Screen = "menu" | "game" | "results" | "highscores" | "settings";

export type UserSession = {
  authenticated: boolean;
  channelConnected: boolean;
  eventsubStatus?: string;
  rewardStatus?: string;
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
  rewardCost: number;
  rewardCooldownSeconds: number;
  rewardMaxPerUserPerStream: number;
};

export type GiftEvent = {
  id: string;
  at: number;
  displayName: string;
  total: number;
  anonymous: boolean;
  twitchUserId?: string;
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
  source: "guest" | "gift" | "idle" | "start" | "reward" | "chat";
  twitchUserId?: string;
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
  twitchUserId?: string;
  total: number;
  variant: DuckVariant;
  announceEvent: boolean;
  eventHasSpecial: boolean;
};

export type TwitchParticipant = {
  twitchUserId: string;
  displayName: string;
};

export type PendingTwitchDuck = {
  id: string;
  name: string;
  twitchUserId: string;
  source: "reward" | "chat";
  redemptionId?: string;
};

export type RewardSettings = {
  cost: number;
  globalCooldownSeconds: number;
  maxPerUserPerStream: number;
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
  processedTwitchEventIds: string[];
  processedGiftIds?: string[];
  pendingGiftDucks: PendingGiftDuck[];
  pendingTwitchDucks: PendingTwitchDuck[];
  raffleParticipants: TwitchParticipant[];
  raffleEndsAt: number;
  lastRaffleWinner?: string;
  pendingReplacementAt?: number[];
};

export type HighscoreEntry = {
  id: string;
  score: number;
  caught: number;
  playedAt: number;
  displayName: string;
};
