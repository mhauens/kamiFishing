import "./style.css";
import { fetchGiftEvents, fetchServerSettings, fetchSession, logout, openTwitchPopup } from "./api";
import { ASSETS } from "./assets";
import { moveAimTarget, moveAimTowardGoal } from "./game/aim";
import { duckSizeForDepth, sortDucksBackToFront } from "./game/depth";
import {
  CATCH_COOLDOWN_MS,
  CATCH_REPLACEMENT_DELAY_MS,
  GUEST_SPECIAL_CHANCE,
  MAX_ACTIVE_DUCKS,
  NEW_DUCK_CATCHABLE_DELAY_MS,
  TWITCH_IDLE_SPECIAL_CHANCE,
  canSpawnDuck,
  catchReplacementSpecialChance,
  chooseDuckVariant,
  duckSpeedForVariant,
  formatTime,
  giftBannerText,
  isDuckCatchable,
  pendingGiftDucksFromEvent,
  shouldSpawnIdleDuck
} from "./game/rules";
import {
  SKILL_HIT_TOLERANCE,
  SKILL_CHECK_SPEED,
  activeSkillTargetIndex,
  createSkillCheckState,
  isSkillSweepHit,
  rerollSkillCheck,
  resetSkillCheck,
  type SkillCheckState
} from "./game/skill";
import { clampToWater, moveDuckWithinWater, randomDuckWaterPoint } from "./game/water";
import {
  addHighscore,
  clearActiveRun,
  loadActiveRun,
  loadHighscores,
  loadSettings,
  normalizeSettings,
  saveActiveRun,
  saveSettings
} from "./storage";
import type {
  CatchRecord,
  Duck,
  DuckVariant,
  GameSettings,
  GiftEvent,
  PendingGiftDuck,
  RunMode,
  SavedRun,
  Screen,
  UserSession
} from "./types";

const LOGICAL_WIDTH = 1920;
const LOGICAL_HEIGHT = 1080;
const ROD_LINE_START = { x: 655, y: 560 };
const ROD_SHOT_COLUMNS = 3;
const ROD_SHOT_ROWS = 2;
const ROD_SHOT_FRAMES = ROD_SHOT_COLUMNS * ROD_SHOT_ROWS;
const BANNER_DURATION_MS = 3000;
const SPARKLE_DURATION_MS = 3000;

type CastState = {
  active: boolean;
  power: number;
  bobberX: number;
  bobberY: number;
  targetX: number;
  targetY: number;
  aimGoalX: number;
  aimGoalY: number;
  flight: number;
  shotFrame: number;
};

type GameState = {
  mode: RunMode;
  startedAt: number;
  seed: number;
  ducks: Duck[];
  score: number;
  caughtCount: number;
  skillPhase: number;
  previousVisibleSkillPower: number;
  visibleSkillPower: number;
  skillCheck: SkillCheckState;
  catchHistory: CatchRecord[];
  featuredCatch?: FeaturedCatch;
  catchCooldownUntil: number;
  eventBanners: EventBanner[];
  sparkles: SparkleEffect[];
  lastGuestSpawnAt: number;
  lastGiftAt: number;
  lastDuckPollAt: number;
  lastDuckQuerySince: number;
  processedGiftIds: Set<string>;
  pendingGiftDucks: PendingGiftDuck[];
  pendingReplacementAt: number[];
  cast: CastState;
  ended: boolean;
};

type FeaturedCatch = {
  record: CatchRecord;
  until: number;
};

type EventBanner = {
  id: string;
  text: string;
  variant: DuckVariant;
  enqueuedAt: number;
  startedAt?: number;
};

type SparkleEffect = {
  id: string;
  x: number;
  y: number;
  until: number;
};

type DuckNamingRequest = {
  duckId: string;
  showAfter: number;
};

type DuckSprite = {
  source: string;
  image: HTMLImageElement;
  canvas?: HTMLCanvasElement;
  ready: boolean;
};

type RuntimeSprite = {
  image: HTMLImageElement;
  canvas?: HTMLCanvasElement;
  ready: boolean;
};

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("Missing app root");

let session: UserSession = { authenticated: false, channelConnected: false };
let settings: GameSettings = loadSettings();
let screen: Screen = "menu";
let game: GameState | null = null;
let duckNamingRequest: DuckNamingRequest | null = null;
let lastFrame = performance.now();
let message = "";
const pressedKeys = new Set<string>();

app.innerHTML = `
  <div class="shell">
    <canvas width="${LOGICAL_WIDTH}" height="${LOGICAL_HEIGHT}" aria-label="Kami Fishing game canvas"></canvas>
    <div class="overlay" id="overlay"></div>
  </div>
`;

const canvas = app.querySelector("canvas");
const overlay = app.querySelector<HTMLDivElement>("#overlay");
if (!canvas || !overlay) throw new Error("Missing UI nodes");
const canvasNode: HTMLCanvasElement = canvas;
const context = canvasNode.getContext("2d");
if (!context) throw new Error("Canvas is not supported");
const ctx: CanvasRenderingContext2D = context;
const overlayNode: HTMLDivElement = overlay;
ctx.imageSmoothingEnabled = false;

const backgroundImage = new Image();
backgroundImage.src = ASSETS.background;

const rodSprite: RuntimeSprite = {
  image: new Image(),
  ready: false
};
rodSprite.image.addEventListener("load", () => {
  rodSprite.canvas = cutOutSpriteBackground(rodSprite.image);
  rodSprite.ready = true;
});
rodSprite.image.src = ASSETS.rod;

const rodShotSprite: RuntimeSprite = {
  image: new Image(),
  ready: false
};
rodShotSprite.image.addEventListener("load", () => {
  rodShotSprite.canvas = cutOutSpriteBackground(rodShotSprite.image);
  rodShotSprite.ready = true;
});
rodShotSprite.image.src = ASSETS.rodShot;

const duckSprites: DuckSprite[] = ASSETS.ducks.map((source) => {
  const image = new Image();
  const sprite: DuckSprite = { source, image, ready: false };
  image.addEventListener("load", () => {
    sprite.canvas = cutOutSpriteBackground(image);
    sprite.ready = true;
  });
  image.src = source;
  return sprite;
});

const specialDuckSprites: DuckSprite[] = ASSETS.specialDucks.map((source) => {
  const image = new Image();
  const sprite: DuckSprite = { source, image, ready: false };
  image.addEventListener("load", () => {
    sprite.canvas = cutOutSpriteBackground(image);
    sprite.ready = true;
  });
  image.src = source;
  return sprite;
});

window.addEventListener("message", async (event: MessageEvent) => {
  if (event.origin !== window.location.origin) return;
  if (event.data?.type !== "kami:twitch-auth") return;
  session = await fetchSession();
  message = event.data.ok ? "Twitch verbunden." : event.data.error || "Twitch Login fehlgeschlagen.";
  renderOverlay();
});

canvas.addEventListener("mousemove", (event) => {
  if (!game || screen !== "game" || game.cast.active || duckNamingRequest) return;
  const point = pointerToCanvasPoint(event);
  const target = clampToWater(point);
  game.cast.aimGoalX = target.x;
  game.cast.aimGoalY = target.y;
});

canvas.addEventListener("pointerdown", (event) => {
  if (!game || screen !== "game" || game.cast.active || duckNamingRequest) return;
  event.preventDefault();
  const point = pointerToCanvasPoint(event);
  const target = clampToWater(point);
  game.cast.aimGoalX = target.x;
  game.cast.aimGoalY = target.y;
  handleSkillClick(game);
});

window.addEventListener("keydown", (event) => {
  if (event.target instanceof HTMLInputElement) return;

  if (duckNamingRequest && screen === "game") {
    event.preventDefault();
    pressedKeys.clear();
    return;
  }

  if (!game || screen !== "game") {
    if (event.key === "Escape" && screen !== "menu") {
      screen = "menu";
      renderOverlay();
    }
    return;
  }

  if (
    ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "a", "A", "d", "D", "w", "W", "s", "S", "Escape"].includes(event.key)
  ) {
    event.preventDefault();
  }

  if (event.key === "Escape") {
    screen = "menu";
    pressedKeys.clear();
    persistRun();
    renderOverlay();
  } else {
    pressedKeys.add(event.key.toLowerCase());
  }
});

window.addEventListener("keyup", (event) => {
  if (!game || screen !== "game") return;
  pressedKeys.delete(event.key.toLowerCase());
});

void boot();

async function boot(): Promise<void> {
  const [nextSession, serverSettings] = await Promise.all([fetchSession(), fetchServerSettings()]);
  session = nextSession;
  settings = saveSettings(normalizeSettings({ ...settings, ...serverSettings }));

  const restored = loadActiveRun();
  if (restored) {
    game = createGame(restored.mode, restored);
    screen = "game";
    message = "Aktiver Run wurde aus sessionStorage wiederhergestellt.";
  }

  renderOverlay();
  requestAnimationFrame(tick);
}

function tick(now: number): void {
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;

  if (game && screen === "game") {
    updateGame(game, dt, now);
    if (duckNamingRequest && Date.now() >= duckNamingRequest.showAfter && overlayNode.childElementCount === 0) {
      renderOverlay();
    }
  }

  draw();
  requestAnimationFrame(tick);
}

function startGame(mode: RunMode): void {
  pressedKeys.clear();
  duckNamingRequest = null;
  game = createGame(mode);
  screen = "game";
  message = "";
  persistRun();
  renderOverlay();
}

function createGame(mode: RunMode, saved?: SavedRun): GameState {
  const seed = saved?.seed ?? Math.floor(Math.random() * 1_000_000);
  const now = Date.now();
  const state: GameState = {
    mode,
    startedAt: saved?.startedAt ?? now,
    seed,
    ducks: [],
    score: saved?.score ?? 0,
    caughtCount: saved?.caughtCount ?? saved?.ducks?.filter((duck) => duck.caught).length ?? 0,
    skillPhase: 0,
    previousVisibleSkillPower: 0,
    visibleSkillPower: 0,
    skillCheck: createSkillCheckState(),
    catchHistory: saved?.catchHistory ?? [],
    catchCooldownUntil: saved?.catchCooldownUntil ?? 0,
    eventBanners: [],
    sparkles: [],
    lastGuestSpawnAt: saved?.lastGuestSpawnAt ?? now,
    lastGiftAt: saved?.lastGiftAt ?? now,
    lastDuckPollAt: 0,
    lastDuckQuerySince: saved?.lastDuckQuerySince ?? now - 5000,
    processedGiftIds: new Set(saved?.processedGiftIds ?? []),
    pendingGiftDucks: saved?.pendingGiftDucks ?? [],
    pendingReplacementAt: saved?.pendingReplacementAt ?? [],
    cast: {
      active: false,
      power: 0,
      bobberX: ROD_LINE_START.x,
      bobberY: ROD_LINE_START.y,
      targetX: 880,
      targetY: 700,
      aimGoalX: 880,
      aimGoalY: 700,
      flight: 0,
      shotFrame: 0
    },
    ended: false
  };

  if (saved?.ducks?.length) {
    state.ducks = saved.ducks
      .filter((duck) => !duck.caught)
      .slice(0, MAX_ACTIVE_DUCKS)
      .map(normalizeSavedDuck);
  } else {
    const initialCount = mode === "guest" ? 5 : 4;
    for (let index = 0; index < initialCount; index += 1) {
      const variant = mode === "guest" ? chooseDuckVariant(GUEST_SPECIAL_CHANCE) : "normal";
      addDuckIfCapacity(state, createDuck("start", { variant, catchableDelayMs: 0, now }));
    }
  }
  return state;
}

function updateGame(state: GameState, dt: number, now: number): void {
  const namingLocked = duckNamingRequest !== null;
  if (!namingLocked) {
    state.skillPhase = (state.skillPhase + dt * SKILL_CHECK_SPEED) % 1;
    if (!state.cast.active) {
      state.cast.power = (Math.sin(state.skillPhase * Math.PI * 2 - Math.PI / 2) + 1) / 2;
    }

    updateAimTarget(state, dt);
  }

  for (const duck of state.ducks) {
    if (duck.caught) continue;
    updateDuckMovement(duck, dt);
    moveDuckWithinWater(duck, dt);
    duck.bob += dt * 3;
  }

  drainGiftDuckQueue(state, Date.now());
  processCatchReplacementQueue(state, Date.now());

  if (
    state.mode === "guest" &&
    state.pendingReplacementAt.length === 0 &&
    Date.now() - state.lastGuestSpawnAt > settings.guestDuckIntervalSeconds * 1000
  ) {
    addDuckIfCapacity(
      state,
      createDuck("guest", {
        variant: chooseDuckVariant(GUEST_SPECIAL_CHANCE),
        catchableDelayMs: NEW_DUCK_CATCHABLE_DELAY_MS
      })
    );
    state.lastGuestSpawnAt = Date.now();
  }

  if (state.mode === "twitch" && session.channelConnected) {
    void pollGiftEvents(state, now);
    if (
      state.pendingGiftDucks.length === 0 &&
      state.pendingReplacementAt.length === 0 &&
      shouldSpawnIdleDuck(Date.now(), state.lastGiftAt, settings.twitchIdleDuckSeconds)
    ) {
      if (canSpawnDuck(state.ducks.length)) {
        const duck = createDuck("idle", {
          variant: chooseDuckVariant(TWITCH_IDLE_SPECIAL_CHANCE),
          catchableDelayMs: NEW_DUCK_CATCHABLE_DELAY_MS
        });
        if (addDuckIfCapacity(state, duck)) requestDuckName(duck);
      }
      state.lastGiftAt = Date.now();
    }
  }

  if (!namingLocked) updateCast(state, dt);
  updateEventBanners(state, now);
  state.sparkles = state.sparkles.filter((sparkle) => sparkle.until > Date.now());
  persistRunThrottled(state);
}

function updateDuckMovement(duck: Duck, dt: number): void {
  if (duck.variant !== "special") return;

  duck.movementPhase += dt * 4;
  const turn = Math.sin(duck.movementPhase) * 0.018;
  const cos = Math.cos(turn);
  const sin = Math.sin(turn);
  const vx = duck.vx * cos - duck.vy * sin;
  const vy = duck.vx * sin + duck.vy * cos;
  duck.vx = vx;
  duck.vy = vy;
}

function updateAimTarget(state: GameState, dt: number): void {
  if (state.cast.active) return;

  const goal = moveAimTarget(
    { x: state.cast.aimGoalX, y: state.cast.aimGoalY },
    {
      left: pressedKeys.has("arrowleft") || pressedKeys.has("a"),
      right: pressedKeys.has("arrowright") || pressedKeys.has("d"),
      up: pressedKeys.has("arrowup") || pressedKeys.has("w"),
      down: pressedKeys.has("arrowdown") || pressedKeys.has("s")
    },
    dt
  );
  state.cast.aimGoalX = goal.x;
  state.cast.aimGoalY = goal.y;

  const target = moveAimTowardGoal(
    { x: state.cast.targetX, y: state.cast.targetY },
    { x: state.cast.aimGoalX, y: state.cast.aimGoalY },
    dt,
    (Date.now() - state.startedAt) / 1000
  );
  state.cast.targetX = target.x;
  state.cast.targetY = target.y;
}

async function pollGiftEvents(state: GameState, now: number): Promise<void> {
  if (document.hidden) return;
  if (now - state.lastDuckPollAt < settings.duckEventPollSeconds * 1000) return;
  state.lastDuckPollAt = now;

  const events = await fetchGiftEvents(state.lastDuckQuerySince);
  for (const event of events) {
    state.lastDuckQuerySince = Math.max(state.lastDuckQuerySince, event.at);
    if (state.processedGiftIds.has(event.id)) continue;
    state.processedGiftIds.add(event.id);
    enqueueGiftEventDucks(state, event);
  }
  persistRun(state);
}

function enqueueGiftEventDucks(state: GameState, event: GiftEvent): void {
  const pendingDucks = pendingGiftDucksFromEvent(event, settings.subsPerDuck);
  if (pendingDucks.length === 0) return;

  const now = Date.now();
  state.pendingGiftDucks.push(...pendingDucks);
  state.lastGiftAt = now;
  drainGiftDuckQueue(state, now);
}

function drainGiftDuckQueue(state: GameState, now: number): void {
  while (state.pendingGiftDucks.length > 0 && canSpawnDuck(state.ducks.length)) {
    const pending = state.pendingGiftDucks.shift();
    if (!pending) break;

    const duck = createDuck("gift", {
      name: pending.name,
      variant: pending.variant,
      catchableDelayMs: NEW_DUCK_CATCHABLE_DELAY_MS,
      now
    });
    if (!addDuckIfCapacity(state, duck)) {
      state.pendingGiftDucks.unshift(pending);
      break;
    }

    if (pending.variant === "special") {
      state.sparkles.push(createSparkle(duck.x, duck.y, now));
    }
    if (pending.announceEvent) {
      enqueueGiftBannerFromPending(state, pending, now);
    }
  }
}

function enqueueGiftBannerFromPending(state: GameState, pending: PendingGiftDuck, now: number): void {
  state.eventBanners.push({
    id: `${pending.eventId}-${state.eventBanners.length}`,
    text: giftBannerText(pending.name, pending.total, pending.eventHasSpecial),
    variant: pending.eventHasSpecial ? "special" : "normal",
    enqueuedAt: now
  });
}

function addDuckIfCapacity(state: GameState, duck: Duck): boolean {
  if (!canSpawnDuck(state.ducks.length)) return false;
  state.ducks.push(duck);
  return true;
}

function updateEventBanners(state: GameState, now: number): void {
  const active = state.eventBanners[0];
  if (!active) return;

  if (active.startedAt === undefined) {
    active.startedAt = now;
    return;
  }

  if (now - active.startedAt >= BANNER_DURATION_MS) {
    state.eventBanners.shift();
    if (state.eventBanners[0]) state.eventBanners[0].startedAt = now;
  }
}

function createSparkle(x: number, y: number, now: number): SparkleEffect {
  return {
    id: crypto.randomUUID(),
    x,
    y,
    until: now + SPARKLE_DURATION_MS
  };
}

function updateCast(state: GameState, dt: number): void {
  const cast = state.cast;
  if (!cast.active) return;

  cast.flight = Math.min(1, cast.flight + dt * 2.4);
  cast.shotFrame = Math.min(ROD_SHOT_FRAMES - 1, Math.floor(cast.flight * ROD_SHOT_FRAMES));
  const t = easeOut(cast.flight);
  cast.bobberX = ROD_LINE_START.x + (cast.targetX - ROD_LINE_START.x) * t;
  cast.bobberY = ROD_LINE_START.y + (cast.targetY - ROD_LINE_START.y) * t - Math.sin(t * Math.PI) * 110;

  if (cast.flight >= 1) {
    const now = Date.now();
    let caughtDuckId: string | undefined;
    for (const duck of state.ducks) {
      if (duck.caught) continue;
      if (!isDuckCatchable(duck.catchableAt, now)) continue;
      const distance = Math.hypot(duck.x - cast.targetX, duck.y - cast.targetY);
      if (distance < 75) {
        duck.caught = true;
        state.score += duck.name ? 150 : 100;
        recordCatch(state, duck);
        state.caughtCount += 1;
        state.catchCooldownUntil = now + CATCH_COOLDOWN_MS;
        caughtDuckId = duck.id;
        break;
      }
    }
    if (caughtDuckId) {
      state.ducks = state.ducks.filter((duck) => duck.id !== caughtDuckId);
      if (duckNamingRequest?.duckId === caughtDuckId) {
        duckNamingRequest = null;
        renderOverlay();
      }
      const countBeforeGiftQueue = state.ducks.length;
      drainGiftDuckQueue(state, now);
      if (state.ducks.length === countBeforeGiftQueue) {
        state.pendingReplacementAt.push(now + CATCH_REPLACEMENT_DELAY_MS);
      }
    }
    cast.active = false;
    cast.power = 0;
    cast.shotFrame = 0;
    resetSkillCheck(state.skillCheck);
  }
}

function processCatchReplacementQueue(state: GameState, now: number): void {
  const replacementAt = state.pendingReplacementAt[0];
  if (replacementAt === undefined || now < replacementAt || duckNamingRequest) return;

  const variant = chooseDuckVariant(catchReplacementSpecialChance(state.mode));
  const duck = createDuck(state.mode === "guest" ? "guest" : "idle", {
    variant,
    catchableDelayMs: NEW_DUCK_CATCHABLE_DELAY_MS,
    now
  });
  if (!addDuckIfCapacity(state, duck)) return;

  state.pendingReplacementAt.shift();
  if (state.mode === "twitch") {
    requestDuckName(duck);
  }
}

function handleSkillClick(state: GameState): void {
  if (Date.now() < state.catchCooldownUntil) return;

  const activeIndex = activeSkillTargetIndex(state.skillCheck);
  const target = state.skillCheck.targets[activeIndex];

  const checkedPower = state.visibleSkillPower;

  if (!isSkillSweepHit(state.previousVisibleSkillPower, checkedPower, target)) {
    resetSkillCheck(state.skillCheck);
    state.skillCheck.missUntil = Date.now() + 450;
    return;
  }

  state.skillCheck.hits[activeIndex] = true;
  state.skillCheck.errors[activeIndex] = Math.abs(checkedPower - target);
  releaseCast(state);
}

function releaseCast(state: GameState): void {
  state.cast.active = true;
  state.cast.flight = 0;
  state.cast.shotFrame = 0;
  state.cast.bobberX = ROD_LINE_START.x;
  state.cast.bobberY = ROD_LINE_START.y;

  const averageError = state.skillCheck.errors.reduce((sum, error) => sum + error, 0) / state.skillCheck.errors.length;
  const spread = 8 + averageError * 260;
  const targetX = state.cast.targetX + (Math.random() - 0.5) * spread;
  const targetY = state.cast.targetY + (Math.random() - 0.5) * spread;
  const target = clampToWater({ x: targetX, y: targetY });
  state.cast.targetX = target.x;
  state.cast.targetY = target.y;
}

function recordCatch(state: GameState, duck: Duck): void {
  const record: CatchRecord = {
    id: duck.id,
    name: duck.name?.trim() || "Duck",
    spriteIndex: duck.spriteIndex,
    variant: duck.variant,
    source: duck.source,
    caughtAt: Date.now()
  };

  state.catchHistory.unshift(record);
  state.catchHistory = state.catchHistory.slice(0, 12);
  state.featuredCatch = {
    record,
    until: Date.now() + 2200
  };
  rerollSkillCheck(state.skillCheck);
}

function pointerToCanvasPoint(event: MouseEvent): { x: number; y: number } {
  const rect = canvasNode.getBoundingClientRect();
  return {
    x: ((event.clientX - rect.left) / rect.width) * LOGICAL_WIDTH,
    y: ((event.clientY - rect.top) / rect.height) * LOGICAL_HEIGHT
  };
}

function finishGame(): void {
  if (!game) return;
  duckNamingRequest = null;
  game.ended = true;
  if (session.authenticated) {
    addHighscore(session, {
      score: game.score,
      caught: game.caughtCount,
      playedAt: Date.now()
    });
  }
  clearActiveRun();
  screen = "results";
  renderOverlay();
}

let lastPersist = 0;
function persistRunThrottled(state: GameState): void {
  const now = Date.now();
  if (now - lastPersist < 1000) return;
  lastPersist = now;
  persistRun(state);
}

function persistRun(state = game): void {
  if (!state) return;
  saveActiveRun({
    mode: state.mode,
    startedAt: state.startedAt,
    score: state.score,
    caughtCount: state.caughtCount,
    seed: state.seed,
    ducks: state.ducks,
    catchHistory: state.catchHistory,
    catchCooldownUntil: state.catchCooldownUntil,
    lastGuestSpawnAt: state.lastGuestSpawnAt,
    lastGiftAt: state.lastGiftAt,
    lastDuckQuerySince: state.lastDuckQuerySince,
    processedGiftIds: [...state.processedGiftIds],
    pendingGiftDucks: state.pendingGiftDucks,
    pendingReplacementAt: state.pendingReplacementAt
  });
}

function normalizeSavedDuck(duck: Duck): Duck {
  return {
    ...duck,
    movementPhase: duck.movementPhase ?? Math.random() * Math.PI * 2,
    catchableAt: duck.catchableAt ?? Date.now(),
    variant: duck.variant ?? "normal"
  };
}

type CreateDuckOptions = {
  name?: string;
  variant?: DuckVariant;
  catchableDelayMs?: number;
  now?: number;
};

function createDuck(source: Duck["source"], options: CreateDuckOptions = {}): Duck {
  const now = options.now ?? Date.now();
  const variant = options.variant ?? "normal";
  const point = randomDuckWaterPoint();
  const speed = duckSpeedForVariant(18 + Math.random() * 22, variant);
  const angle = Math.random() * Math.PI * 2;
  const spritePool = variant === "special" ? specialDuckSprites : duckSprites;
  return {
    id: crypto.randomUUID(),
    x: point.x,
    y: point.y,
    vx: Math.cos(angle) * speed,
    vy: Math.sin(angle) * speed * 0.55,
    bob: Math.random() * Math.PI * 2,
    movementPhase: Math.random() * Math.PI * 2,
    name: options.name,
    spriteIndex: Math.floor(Math.random() * spritePool.length),
    variant,
    catchableAt: now + (options.catchableDelayMs ?? 0),
    caught: false,
    source
  };
}

function requestDuckName(duck: Duck, showAfter = Date.now()): void {
  if (duckNamingRequest) return;
  duckNamingRequest = { duckId: duck.id, showAfter };
  if (showAfter <= Date.now()) renderOverlay();
}

function completeDuckNaming(name?: string): void {
  if (!duckNamingRequest || !game) return;

  const duck = game.ducks.find((candidate) => candidate.id === duckNamingRequest?.duckId);
  const trimmedName = name?.trim().slice(0, 18);
  if (duck && trimmedName) duck.name = trimmedName;

  duckNamingRequest = null;
  persistRun(game);
  renderOverlay();
}

function draw(): void {
  drawScene();
  if (game) drawGameObjects(game);
  drawRodForeground();
  drawHud();
  if (game) {
    drawCatchHistory(game);
    drawEventBanner(game);
    drawFeaturedCatch(game);
  }
}

function drawScene(): void {
  if (backgroundImage.complete && backgroundImage.naturalWidth > 0) {
    ctx.drawImage(backgroundImage, 0, 0, LOGICAL_WIDTH, LOGICAL_HEIGHT);
    return;
  }

  drawFallbackScene();
}

function drawFallbackScene(): void {
  const gradient = ctx.createLinearGradient(0, 0, 0, LOGICAL_HEIGHT);
  gradient.addColorStop(0, "#23a3e6");
  gradient.addColorStop(0.35, "#7bc15a");
  gradient.addColorStop(1, "#236b36");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, LOGICAL_WIDTH, LOGICAL_HEIGHT);

  drawClouds();
  drawTrees();
  drawPond();
  drawDock();
}

function drawClouds(): void {
  ctx.fillStyle = "rgba(255,255,255,0.78)";
  for (const [x, y] of [
    [150, 120],
    [330, 100],
    [1230, 90]
  ]) {
    pixelCircle(x, y, 40);
    pixelCircle(x + 42, y - 12, 58);
    pixelCircle(x + 95, y + 8, 36);
  }
}

function drawTrees(): void {
  for (let x = -40; x < LOGICAL_WIDTH + 80; x += 90) {
    ctx.fillStyle = x % 270 === 0 ? "#9d2927" : "#236b24";
    pixelCircle(x, 250 + Math.sin(x) * 18, 95);
    ctx.fillStyle = "#1f4f23";
    pixelCircle(x + 28, 290, 75);
  }
  ctx.fillStyle = "#2f701e";
  ctx.fillRect(0, 250, LOGICAL_WIDTH, 120);
}

function drawPond(): void {
  ctx.fillStyle = "#72613b";
  ctx.beginPath();
  ctx.ellipse(900, 630, 780, 330, -0.08, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#075a57";
  ctx.beginPath();
  ctx.ellipse(900, 620, 710, 280, -0.08, 0, Math.PI * 2);
  ctx.fill();

  for (let i = 0; i < 130; i += 1) {
    ctx.fillStyle = i % 2 ? "#0c7668" : "#1d8a75";
    const x = 240 + ((i * 97) % 1280);
    const y = 390 + ((i * 53) % 440);
    ctx.fillRect(x, y, 16, 3);
  }

  ctx.fillStyle = "#b89453";
  for (let i = 0; i < 80; i += 1) {
    pixelCircle(180 + ((i * 71) % 1500), 350 + ((i * 43) % 560), 8 + (i % 4) * 3);
  }
}

function drawDock(): void {
  ctx.fillStyle = "#6d3d1d";
  ctx.fillRect(1370, 520, 360, 35);
  ctx.fillRect(1320, 555, 500, 38);
  ctx.fillStyle = "#9b5a2a";
  for (let x = 1325; x < 1810; x += 42) ctx.fillRect(x, 548, 28, 58);
  ctx.fillStyle = "#3b1f11";
  ctx.fillRect(1390, 590, 18, 85);
  ctx.fillRect(1660, 590, 18, 82);
}

function drawRodForeground(): void {
  if (game?.cast.active && rodShotSprite.ready && rodShotSprite.canvas) {
    drawRodShotFrame(game.cast.shotFrame);
  } else if (rodSprite.ready && rodSprite.canvas) {
    ctx.drawImage(rodSprite.canvas, 200, 465, 520, 750);
  } else {
    ctx.fillStyle = "#4a2916";
    ctx.save();
    ctx.translate(420, 980);
    ctx.rotate(-0.55);
    ctx.fillRect(-45, -260, 50, 430);
    ctx.fillStyle = "#a86528";
    ctx.fillRect(-33, -250, 26, 410);
    ctx.restore();
  }

  if (!game?.cast.active || rodShotSprite.ready) return;

  ctx.strokeStyle = "#d9e7d8";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(ROD_LINE_START.x, ROD_LINE_START.y);
  ctx.lineTo(game.cast.bobberX, game.cast.bobberY);
  ctx.stroke();
}

function drawRodShotFrame(frame: number): void {
  if (!rodShotSprite.canvas) return;

  const frameWidth = rodShotSprite.canvas.width / ROD_SHOT_COLUMNS;
  const frameHeight = rodShotSprite.canvas.height / ROD_SHOT_ROWS;
  const safeFrame = Math.max(0, Math.min(ROD_SHOT_FRAMES - 1, frame));
  const sourceX = (safeFrame % ROD_SHOT_COLUMNS) * frameWidth;
  const sourceY = Math.floor(safeFrame / ROD_SHOT_COLUMNS) * frameHeight;

  ctx.drawImage(rodShotSprite.canvas, sourceX, sourceY, frameWidth, frameHeight, 50, 350, 840, 840);
}

function drawGameObjects(state: GameState): void {
  const visibleDucks = sortDucksBackToFront(state.ducks.filter((duck) => !duck.caught));

  for (const duck of visibleDucks) {
    drawDuck(duck);
  }

  drawSparkles(state);

  if (!state.cast.active && !duckNamingRequest) {
    drawAimReticle(state);
  }

  if (state.cast.active && !rodShotSprite.ready) {
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(state.cast.bobberX, state.cast.bobberY, 12, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function drawAimReticle(state: GameState): void {
  const activeIndex = activeSkillTargetIndex(state.skillCheck);
  const skillError = Math.abs(state.cast.power - state.skillCheck.targets[activeIndex]);
  const pulse = 1 + state.cast.power * 0.28;
  const radius = 24 * pulse;
  ctx.save();
  ctx.translate(state.cast.targetX, state.cast.targetY);
  ctx.strokeStyle = skillError <= SKILL_HIT_TOLERANCE ? "#74ff8a" : state.skillCheck.missUntil > Date.now() ? "#ff5a4f" : "#ffffff";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(0, 0, radius, 0, Math.PI * 2);
  ctx.moveTo(-radius - 14, 0);
  ctx.lineTo(-8, 0);
  ctx.moveTo(8, 0);
  ctx.lineTo(radius + 14, 0);
  ctx.moveTo(0, -radius - 14);
  ctx.lineTo(0, -8);
  ctx.moveTo(0, 8);
  ctx.lineTo(0, radius + 14);
  ctx.stroke();
  ctx.strokeStyle = "#74ff8a";
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.arc(0, 0, radius + 10, Math.PI * 1.34, Math.PI * 1.66);
  ctx.stroke();
  ctx.restore();
}

function drawDuck(duck: Duck): void {
  const y = duck.y + Math.sin(duck.bob) * 6;
  const size = duckSizeForDepth(duck.y);
  const duckTop = y - size + 34 * (size / 118);
  const nameBaseline = duckTop - 8;
  const sprites = spritesForVariant(duck.variant);
  const sprite = sprites[duck.spriteIndex % sprites.length];

  if (sprite?.ready && sprite.canvas) {
    drawDuckSprite(duck.spriteIndex, duck.variant, duck.x, y, size, duck.vx < 0);
  } else {
    drawFallbackDuck(duck, y);
  }

  drawCatchableMarker(duck, duckTop, nameBaseline);

  if (duck.name) {
    ctx.save();
    ctx.fillStyle = "rgba(255, 255, 255, 0.9)";
    ctx.shadowColor = "rgba(0, 0, 0, 0.75)";
    ctx.shadowBlur = 3;
    ctx.shadowOffsetY = 1;
    ctx.font = "17px Consolas, monospace";
    ctx.textAlign = "center";
    ctx.fillText(duck.name.slice(0, 18), duck.x, nameBaseline);
    ctx.restore();
  }
}

function drawCatchableMarker(duck: Duck, duckTop: number, nameBaseline: number): void {
  const remainingMs = duck.catchableAt - Date.now();
  if (remainingMs <= 0) return;

  const label = formatTime(remainingMs / 1000);
  const timerY = duck.name ? nameBaseline - 42 : duckTop - 34;
  ctx.save();
  ctx.fillStyle = "rgba(32, 17, 9, 0.86)";
  ctx.fillRect(duck.x - 38, timerY, 76, 26);
  ctx.strokeStyle = "#ffd35e";
  ctx.lineWidth = 2;
  ctx.strokeRect(duck.x - 38, timerY, 76, 26);
  ctx.fillStyle = "#ffd35e";
  ctx.font = "17px Consolas, monospace";
  ctx.textAlign = "center";
  ctx.fillText(label, duck.x, timerY + 19);
  ctx.restore();
}

function drawDuckSprite(spriteIndex: number, variant: DuckVariant, x: number, y: number, size: number, facingLeft = false): void {
  const sprites = spritesForVariant(variant);
  const sprite = sprites[spriteIndex % sprites.length];
  if (!sprite?.ready || !sprite.canvas) return;

  ctx.save();
  ctx.translate(x, y);
  if (facingLeft) ctx.scale(-1, 1);
  ctx.drawImage(sprite.canvas, -size / 2, -size + 34 * (size / 118), size, size);
  ctx.restore();
}

function spritesForVariant(variant: DuckVariant): DuckSprite[] {
  return variant === "special" ? specialDuckSprites : duckSprites;
}

function drawFeaturedCatch(state: GameState): void {
  if (!state.featuredCatch || state.featuredCatch.until < Date.now()) return;

  const alpha = Math.min(1, (state.featuredCatch.until - Date.now()) / 350);
  const isSpecial = state.featuredCatch.record.variant === "special";
  ctx.save();
  ctx.globalAlpha = alpha;
  panel(685, 170, 550, 260);
  if (isSpecial) {
    ctx.strokeStyle = "#ffd35e";
    ctx.lineWidth = 8;
    ctx.strokeRect(695, 180, 530, 240);
  }
  ctx.fillStyle = isSpecial ? "#fff08a" : "#ffd35e";
  ctx.font = "36px Consolas, monospace";
  ctx.textAlign = "center";
  ctx.fillText(isSpecial ? "RARE! CAUGHT!" : "CAUGHT!", 960, 220);
  drawDuckSprite(state.featuredCatch.record.spriteIndex, state.featuredCatch.record.variant, 960, 345, 185);
  ctx.fillStyle = "#fff4c8";
  ctx.font = "28px Consolas, monospace";
  ctx.fillText(state.featuredCatch.record.name.slice(0, 20), 960, 395);
  ctx.restore();
}

function drawCatchHistory(state: GameState): void {
  panel(1570, 650, 315, 360);
  ctx.fillStyle = "#ffd35e";
  ctx.font = "26px Consolas, monospace";
  ctx.textAlign = "left";
  ctx.fillText("Catch History", 1605, 695);

  const entries = state.catchHistory.slice(0, 5);
  if (entries.length === 0) {
    ctx.fillStyle = "#fff4c8";
    ctx.font = "20px Consolas, monospace";
    ctx.fillText("No catches yet", 1605, 745);
    return;
  }

  entries.forEach((entry, index) => {
    const rowTop = 714 + index * 56;
    const rowHeight = 52;
    const rowCenter = rowTop + rowHeight / 2;
    if (entry.variant === "special") {
      ctx.strokeStyle = "#ffd35e";
      ctx.lineWidth = 3;
      ctx.strokeRect(1595, rowTop, 270, rowHeight);
    }
    drawDuckSprite(entry.spriteIndex, entry.variant, 1630, rowCenter + 10, 46);
    ctx.fillStyle = "#fff4c8";
    ctx.font = "20px Consolas, monospace";
    ctx.fillText(entry.name.slice(0, 15), 1670, rowCenter + 7);
  });
}

function drawEventBanner(state: GameState): void {
  const banner = state.eventBanners[0];
  if (!banner?.startedAt) return;

  const age = Date.now() - banner.startedAt;
  const progress = Math.min(1, age / BANNER_DURATION_MS);
  const alpha = progress < 0.82 ? 1 : Math.max(0, 1 - (progress - 0.82) / 0.18);
  const y = 118 - Math.max(0, 1 - progress * 5) * 42;
  ctx.save();
  ctx.globalAlpha = alpha;
  panel(565, y, 790, 82);
  ctx.fillStyle = banner.variant === "special" ? "#fff08a" : "#ffd35e";
  ctx.font = "25px Consolas, monospace";
  ctx.textAlign = "center";
  ctx.fillText(banner.text, 960, y + 52);
  ctx.restore();
}

function drawSparkles(state: GameState): void {
  const now = Date.now();
  for (const sparkle of state.sparkles) {
    const age = 1 - Math.max(0, (sparkle.until - now) / SPARKLE_DURATION_MS);
    const alpha = 1 - age;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = "#fff08a";
    ctx.fillStyle = "#ffd35e";
    ctx.lineWidth = 3;
    for (let index = 0; index < 8; index += 1) {
      const angle = index * (Math.PI / 4) + age * Math.PI * 1.6;
      const distance = 34 + age * 58 + (index % 2) * 16;
      const x = sparkle.x + Math.cos(angle) * distance;
      const y = sparkle.y + Math.sin(angle) * distance * 0.6;
      ctx.beginPath();
      ctx.moveTo(x, y - 8);
      ctx.lineTo(x, y + 8);
      ctx.moveTo(x - 8, y);
      ctx.lineTo(x + 8, y);
      ctx.stroke();
      ctx.fillRect(x - 2, y - 2, 4, 4);
    }
    ctx.restore();
  }
}

function drawFallbackDuck(duck: Duck, y: number): void {
  ctx.strokeStyle = "rgba(140, 230, 230, 0.5)";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.ellipse(duck.x, y + 18, 48, 14, 0, 0, Math.PI * 2);
  ctx.stroke();

  ctx.fillStyle = "#ffc42b";
  pixelCircle(duck.x, y, 34);
  pixelCircle(duck.x + 34, y - 28, 22);
  ctx.fillStyle = "#f07922";
  ctx.fillRect(duck.x + 52, y - 26, 24, 9);
  ctx.fillStyle = "#1c120d";
  ctx.fillRect(duck.x + 39, y - 35, 5, 5);
}

function cutOutSpriteBackground(image: HTMLImageElement): HTMLCanvasElement {
  const scratch = document.createElement("canvas");
  scratch.width = image.naturalWidth;
  scratch.height = image.naturalHeight;
  const scratchCtx = scratch.getContext("2d", { willReadFrequently: true });
  if (!scratchCtx) return scratch;

  scratchCtx.drawImage(image, 0, 0);
  const pixels = scratchCtx.getImageData(0, 0, scratch.width, scratch.height);
  const visited = new Uint8Array(scratch.width * scratch.height);
  const stack: number[] = [];

  for (let x = 0; x < scratch.width; x += 1) {
    stack.push(x, (scratch.height - 1) * scratch.width + x);
  }
  for (let y = 0; y < scratch.height; y += 1) {
    stack.push(y * scratch.width, y * scratch.width + scratch.width - 1);
  }

  while (stack.length > 0) {
    const pixelIndex = stack.pop();
    if (pixelIndex === undefined || visited[pixelIndex]) continue;
    visited[pixelIndex] = 1;

    const dataIndex = pixelIndex * 4;
    if (!isDuckBackgroundPixel(pixels.data, dataIndex)) continue;

    pixels.data[dataIndex + 3] = 0;

    const x = pixelIndex % scratch.width;
    const y = Math.floor(pixelIndex / scratch.width);
    if (x > 0) stack.push(pixelIndex - 1);
    if (x < scratch.width - 1) stack.push(pixelIndex + 1);
    if (y > 0) stack.push(pixelIndex - scratch.width);
    if (y < scratch.height - 1) stack.push(pixelIndex + scratch.width);
  }

  scratchCtx.putImageData(pixels, 0, 0);
  return scratch;
}

function isDuckBackgroundPixel(data: Uint8ClampedArray, index: number): boolean {
  const red = data[index];
  const green = data[index + 1];
  const blue = data[index + 2];
  const alpha = data[index + 3];
  if (alpha < 12) return true;

  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const isWhite = red > 238 && green > 238 && blue > 238;
  const isCreamBackground = red > 228 && green > 214 && blue > 170 && max - min < 72;
  const isEdgeFade = red > 218 && green > 218 && blue > 205 && max - min < 45;

  return isWhite || isCreamBackground || isEdgeFade;
}

function drawHud(): void {
  ctx.textAlign = "left";
  panel(24, 24, 390, 225);
  ctx.font = "42px Consolas, monospace";
  ctx.fillStyle = "#ffd35e";
  ctx.fillText("DUCK RESCUE", 105, 72);
  ctx.font = "25px Consolas, monospace";
  ctx.fillStyle = "#fff4c8";
  ctx.fillText("Catch all the ducks!", 55, 116);
  const caught = game?.caughtCount ?? 0;
  const active = game?.ducks.length ?? 0;
  const queued = game?.pendingGiftDucks.length ?? 0;
  ctx.fillText(`Caught: ${caught}`, 55, 150);
  ctx.fillText(`Pond: ${active} / ${MAX_ACTIVE_DUCKS}${queued > 0 ? ` (+${queued})` : ""}`, 55, 182);
  ctx.fillText(`Score: ${game?.score ?? 0}`, 55, 214);

  panel(24, 890, 320, 165);
  ctx.font = "30px Consolas, monospace";
  ctx.fillStyle = "#ffd35e";
  ctx.fillText("CAST", 55, 934);
  ctx.font = "24px Consolas, monospace";
  ctx.fillStyle = "#fff4c8";
  ctx.fillText("Aim with mouse", 55, 978);
  const cooldownRemaining = game ? Math.max(0, Math.ceil((game.catchCooldownUntil - Date.now()) / 1000)) : 0;
  ctx.fillText("Hit the mark", 55, 1016);

  const currentGame = game;
  if (currentGame && screen === "game" && !currentGame.cast.active) {
    const meterX = 740;
    const meterY = 1018;
    const meterWidth = 440;
    const meterHeight = 20;
    ctx.fillStyle = "#1d0d07";
    ctx.fillRect(meterX - 5, meterY - 1, meterWidth + 10, meterHeight + 2);

    if (duckNamingRequest) {
      ctx.fillStyle = "rgba(37, 19, 10, 0.96)";
      ctx.fillRect(meterX, meterY - 8, meterWidth, 36);
      ctx.strokeStyle = "#ffd35e";
      ctx.lineWidth = 3;
      ctx.strokeRect(meterX, meterY - 8, meterWidth, 36);
      ctx.fillStyle = "#ffd35e";
      ctx.font = "25px Consolas, monospace";
      ctx.textAlign = "center";
      ctx.fillText("ENTE BENENNEN", meterX + meterWidth / 2, meterY + 19);
      ctx.textAlign = "left";
      return;
    }

    currentGame.previousVisibleSkillPower = currentGame.visibleSkillPower;
    currentGame.visibleSkillPower = currentGame.cast.power;

    if (cooldownRemaining > 0) {
      ctx.fillStyle = "rgba(37, 19, 10, 0.96)";
      ctx.fillRect(meterX, meterY - 8, meterWidth, 36);
      ctx.strokeStyle = "#ffd35e";
      ctx.lineWidth = 3;
      ctx.strokeRect(meterX, meterY - 8, meterWidth, 36);
      ctx.fillStyle = "#ffd35e";
      ctx.font = "25px Consolas, monospace";
      ctx.textAlign = "center";
      ctx.fillText(`CATCH COOLDOWN ${cooldownRemaining}s`, meterX + meterWidth / 2, meterY + 19);
      ctx.textAlign = "left";
      return;
    }

    currentGame.skillCheck.targets.forEach((target, index) => {
      const isDone = currentGame.skillCheck.hits[index] === true;
      const isActive = index === activeSkillTargetIndex(currentGame.skillCheck);
      const windowStart = meterX + Math.max(0, target - SKILL_HIT_TOLERANCE) * meterWidth;
      const windowEnd = meterX + Math.min(1, target + SKILL_HIT_TOLERANCE) * meterWidth;
      ctx.fillStyle = isDone ? "#8ee9ff" : isActive ? "#4ee875" : "#d7ff73";
      ctx.fillRect(windowStart, meterY, windowEnd - windowStart, meterHeight);
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(meterX + target * meterWidth - 2, meterY - 4, 4, meterHeight + 8);
    });

    ctx.fillStyle = "rgba(255, 211, 94, 0.72)";
    ctx.fillRect(meterX, meterY + 4, currentGame.visibleSkillPower * meterWidth, 12);
    ctx.fillStyle = "#ffe58a";
    ctx.fillRect(meterX + currentGame.visibleSkillPower * meterWidth - 3, meterY - 6, 6, meterHeight + 12);

    if (currentGame.skillCheck.missUntil > Date.now()) {
      ctx.fillStyle = "#ff5a4f";
      ctx.fillRect(meterX, meterY, meterWidth, meterHeight);
    }

    ctx.strokeStyle = "#ffffff";
    ctx.strokeRect(meterX, meterY, meterWidth, meterHeight);
  }
}

function panel(x: number, y: number, width: number, height: number): void {
  ctx.fillStyle = "rgba(37, 19, 10, 0.94)";
  ctx.fillRect(x, y, width, height);
  ctx.strokeStyle = "#8b5124";
  ctx.lineWidth = 6;
  ctx.strokeRect(x + 3, y + 3, width - 6, height - 6);
  ctx.strokeStyle = "#1d0d07";
  ctx.lineWidth = 3;
  ctx.strokeRect(x + 10, y + 10, width - 20, height - 20);
}

function pixelCircle(x: number, y: number, radius: number): void {
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
}

function easeOut(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

function renderOverlay(): void {
  overlayNode.innerHTML = "";
  if (screen === "game") {
    renderDuckNamingPrompt();
    return;
  }
  if ((screen === "highscores" || screen === "settings") && !session.authenticated) {
    screen = "menu";
  }

  const panelNode = document.createElement("div");
  panelNode.className = "panel";
  overlayNode.append(panelNode);

  if (screen === "menu") renderMenu(panelNode);
  if (screen === "results") renderResults(panelNode);
  if (screen === "highscores") renderHighscores(panelNode);
  if (screen === "settings") renderSettings(panelNode);
}

function renderDuckNamingPrompt(): void {
  if (!duckNamingRequest || !game) return;
  if (Date.now() < duckNamingRequest.showAfter) return;
  const duckExists = game.ducks.some((duck) => duck.id === duckNamingRequest?.duckId);
  if (!duckExists) {
    duckNamingRequest = null;
    return;
  }

  const panelNode = document.createElement("div");
  panelNode.className = "panel duck-name-panel";
  panelNode.innerHTML = `
    <form class="duck-name-form">
      <label for="duck-name">Eine Auto-Spawn-Ente ist angekommen. Wie soll sie heissen?</label>
      <input id="duck-name" name="duck-name" type="text" maxlength="18" autocomplete="off" placeholder="Entenname">
      <div class="button-row">
        <button type="submit">Name vergeben</button>
        <button type="button" data-action="dismiss-duck-name">Ueberspringen</button>
      </div>
    </form>
  `;
  overlayNode.append(panelNode);

  const form = panelNode.querySelector<HTMLFormElement>("form");
  const input = panelNode.querySelector<HTMLInputElement>("#duck-name");
  const dismissButton = panelNode.querySelector<HTMLButtonElement>('[data-action="dismiss-duck-name"]');

  form?.addEventListener("submit", (event) => {
    event.preventDefault();
    completeDuckNaming(input?.value);
  });
  dismissButton?.addEventListener("click", () => completeDuckNaming());
  input?.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    completeDuckNaming();
  });
  input?.focus();
}

function renderMenu(node: HTMLElement): void {
  const userText = session.authenticated && session.user ? `Eingeloggt als ${session.user.displayName}` : "Nicht mit Twitch eingeloggt";
  const hasActiveRun = game !== null && !game.ended;
  const authenticatedActions = session.authenticated
    ? `
      <button data-action="twitch">Play Twitch Run</button>
      <button data-action="scores">Local Highscores</button>
      <button data-action="settings">Settings</button>
      <button data-action="logout">Logout</button>
    `
    : "";
  const disconnectedActions = session.authenticated
    ? ""
    : `
      <button data-action="guest">Play as Guest</button>
      <button data-action="login">Twitch Login</button>
    `;
  node.innerHTML = `
    <h1>Kami Fishing</h1>
    <p>Angel Gummienten aus dem Teich. Guest-Runs laufen komplett lokal, Twitch-Runs koennen Gift-Sub-Enten empfangen und speichern Highscores nur in diesem Browser.</p>
    <p class="status">${userText}${session.channelConnected ? " - Gift-Subs verbunden" : ""}</p>
    ${message ? `<p class="hint">${message}</p>` : ""}
    <div class="button-row">
      ${hasActiveRun ? '<button data-action="resume">Resume Run</button><button data-action="end-run">End Run</button>' : ""}
      ${disconnectedActions}
      ${authenticatedActions}
    </div>
  `;
  bindButtons(node);
}

function renderResults(node: HTMLElement): void {
  const saved = session.authenticated ? "Score wurde lokal fuer deinen Twitch-Account gespeichert." : "Guest-Score wurde nicht gespeichert.";
  node.innerHTML = `
    <h2>Run beendet</h2>
    <p>Score: <strong>${game?.score ?? 0}</strong></p>
    <p>${saved}</p>
    <div class="button-row">
      <button data-action="menu">Menu</button>
      ${session.authenticated ? '<button data-action="scores">Local Highscores</button>' : ""}
      <button data-action="guest">Noch ein Guest Run</button>
      <button data-action="twitch" ${session.authenticated ? "" : "disabled"}>Noch ein Twitch Run</button>
    </div>
  `;
  bindButtons(node);
}

function renderHighscores(node: HTMLElement): void {
  const entries = loadHighscores(session);
  node.innerHTML = `
    <h2>Local Highscores</h2>
    <p>${session.authenticated ? "Nur in diesem Browser fuer deinen Twitch-Account gespeichert." : "Logge dich mit Twitch ein, damit Scores lokal gespeichert werden."}</p>
    <ol class="score-list">
      ${
        entries.length
          ? entries
              .map(
                (entry) =>
                  `<li><span>${new Date(entry.playedAt).toLocaleDateString()} - ${entry.caught} ducks</span><strong>${entry.score}</strong></li>`
              )
              .join("")
          : "<li>Noch keine Scores.</li>"
      }
    </ol>
    <div class="button-row"><button data-action="menu">Menu</button></div>
  `;
  bindButtons(node);
}

function renderSettings(node: HTMLElement): void {
  node.innerHTML = `
    <h2>Settings</h2>
    <p class="hint">Diese Werte bleiben lokal in deinem Browser. Gift-Sub-Events werden roh geholt und hier in Enten umgerechnet.</p>
    <div class="settings-grid">
      <label>Subs pro Ente <input data-setting="subsPerDuck" type="number" min="1" max="100" value="${settings.subsPerDuck}"></label>
      <label>Guest Enten-Intervall (Sek.) <input data-setting="guestDuckIntervalSeconds" type="number" min="3" max="120" value="${settings.guestDuckIntervalSeconds}"></label>
      <label>Twitch Idle-Ente nach (Sek.) <input data-setting="twitchIdleDuckSeconds" type="number" min="15" max="900" value="${settings.twitchIdleDuckSeconds}"></label>
      <label>Gift-Event Polling (Sek.) <input data-setting="duckEventPollSeconds" type="number" min="10" max="120" value="${settings.duckEventPollSeconds}"></label>
    </div>
    <div class="button-row">
      <button data-action="save-settings">Save</button>
      <button data-action="menu">Menu</button>
    </div>
  `;
  bindButtons(node);
}

function bindButtons(node: HTMLElement): void {
  node.querySelectorAll("button[data-action]").forEach((button) => {
    button.addEventListener("click", async () => {
      const action = (button as HTMLButtonElement).dataset.action;
      if (action === "guest") startGame("guest");
      if (action === "twitch") startGame("twitch");
      if (action === "resume") {
        screen = "game";
        renderOverlay();
      }
      if (action === "end-run") finishGame();
      if (action === "login") openTwitchPopup("login");
      if (action === "scores") {
        if (!session.authenticated) return;
        screen = "highscores";
        renderOverlay();
      }
      if (action === "settings") {
        if (!session.authenticated) return;
        screen = "settings";
        renderOverlay();
      }
      if (action === "menu") {
        screen = "menu";
        renderOverlay();
      }
      if (action === "logout") {
        await logout();
        session = await fetchSession();
        message = "Logout abgeschlossen.";
        renderOverlay();
      }
      if (action === "save-settings") {
        const next = { ...settings };
        node.querySelectorAll<HTMLInputElement>("input[data-setting]").forEach((input) => {
          const key = input.dataset.setting as keyof GameSettings;
          next[key] = Number(input.value);
        });
        settings = saveSettings(next);
        message = "Settings gespeichert.";
        screen = "menu";
        renderOverlay();
      }
    });
  });
}
