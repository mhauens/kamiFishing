import type { Duck, PendingTwitchDuck, TwitchParticipant } from "../types";

export const RAFFLE_INTERVAL_MS = 60_000;
export const TWITCH_EVENTSUB_URL = "wss://eventsub.wss.twitch.tv/ws";

export function isDuckCommand(message: string): boolean {
  return message.trim().toLocaleLowerCase("de-DE") === "!ente";
}

export function addUniqueParticipant(
  participants: TwitchParticipant[],
  participant: TwitchParticipant
): TwitchParticipant[] {
  if (participants.some((entry) => entry.twitchUserId === participant.twitchUserId)) return participants;
  return [...participants, participant];
}

export function blockedTwitchUserIds(ducks: Duck[], queued: PendingTwitchDuck[]): Set<string> {
  return new Set(
    [
      ...ducks.filter((duck) => !duck.caught).map((duck) => duck.twitchUserId),
      ...queued.map((duck) => duck.twitchUserId)
    ].filter((id): id is string => Boolean(id))
  );
}

export function drawRaffleWinner(
  participants: TwitchParticipant[],
  blockedIds: ReadonlySet<string>,
  randomValue = Math.random()
): TwitchParticipant | null {
  const eligible = participants.filter((participant) => !blockedIds.has(participant.twitchUserId));
  if (eligible.length === 0) return null;
  const index = Math.min(eligible.length - 1, Math.floor(Math.max(0, randomValue) * eligible.length));
  return eligible[index];
}

export type TwitchEventSubNotification = {
  metadata: {
    message_id: string;
    message_type: string;
    subscription_type?: string;
  };
  payload: {
    session?: {
      id: string;
      keepalive_timeout_seconds?: number | null;
      reconnect_url?: string | null;
    };
    event?: Record<string, unknown>;
  };
};

type EventSubClientOptions = {
  registerSession: (sessionId: string) => Promise<void>;
  onNotification: (message: TwitchEventSubNotification) => void;
  onStatus?: (status: "connecting" | "connected" | "disconnected" | "error") => void;
};

export class TwitchEventSubClient {
  private socket: WebSocket | null = null;
  private reconnectTimer: number | undefined;
  private keepaliveTimer: number | undefined;
  private keepaliveTimeoutSeconds = 10;
  private stopped = true;
  private seenMessageIds = new Set<string>();

  constructor(private readonly options: EventSubClientOptions) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect(TWITCH_EVENTSUB_URL, true);
  }

  stop(): void {
    this.stopped = true;
    window.clearTimeout(this.reconnectTimer);
    window.clearTimeout(this.keepaliveTimer);
    this.socket?.close();
    this.socket = null;
    this.options.onStatus?.("disconnected");
  }

  private connect(url: string, registerSubscriptions: boolean): void {
    if (this.stopped) return;
    this.options.onStatus?.("connecting");
    const socket = new WebSocket(url);
    this.socket = socket;

    socket.addEventListener("message", (event) => {
      void this.handleMessage(socket, String(event.data), registerSubscriptions).catch(() => {
        this.options.onStatus?.("error");
        socket.close();
      });
    });
    socket.addEventListener("error", () => this.options.onStatus?.("error"));
    socket.addEventListener("close", () => {
      if (this.stopped || this.socket !== socket) return;
      this.options.onStatus?.("disconnected");
      this.reconnectTimer = window.setTimeout(() => this.connect(TWITCH_EVENTSUB_URL, true), 2000);
    });
  }

  private async handleMessage(socket: WebSocket, raw: string, registerSubscriptions: boolean): Promise<void> {
    const message = JSON.parse(raw) as TwitchEventSubNotification;
    const messageId = message.metadata.message_id;
    if (this.seenMessageIds.has(messageId)) return;
    this.seenMessageIds.add(messageId);
    while (this.seenMessageIds.size > 500) {
      const first = this.seenMessageIds.values().next().value as string | undefined;
      if (!first) break;
      this.seenMessageIds.delete(first);
    }

    this.armKeepalive(message.payload.session?.keepalive_timeout_seconds);

    if (message.metadata.message_type === "session_welcome") {
      const sessionId = message.payload.session?.id;
      if (registerSubscriptions && sessionId) await this.options.registerSession(sessionId);
      this.options.onStatus?.("connected");
      return;
    }

    if (message.metadata.message_type === "session_reconnect") {
      const reconnectUrl = message.payload.session?.reconnect_url;
      if (reconnectUrl) this.connect(reconnectUrl, false);
      return;
    }

    if (message.metadata.message_type === "notification") {
      this.options.onNotification(message);
    }

    if (this.socket !== socket) socket.close();
  }

  private armKeepalive(timeoutSeconds?: number | null): void {
    if (timeoutSeconds) this.keepaliveTimeoutSeconds = timeoutSeconds;
    window.clearTimeout(this.keepaliveTimer);
    this.keepaliveTimer = window.setTimeout(() => {
      if (this.stopped) return;
      this.socket?.close();
    }, (this.keepaliveTimeoutSeconds + 5) * 1000);
  }
}

type TabLockValue = {
  owner: string;
  expiresAt: number;
};

export class TwitchTabLock {
  private readonly owner = crypto.randomUUID();
  private heartbeat: number | undefined;
  private listening = false;

  constructor(
    private readonly key: string,
    private readonly onLost?: () => void
  ) {}

  acquire(now = Date.now()): boolean {
    const current = this.read();
    if (current && current.owner !== this.owner && current.expiresAt > now) return false;
    this.write(now);
    const confirmed = this.read();
    if (confirmed?.owner !== this.owner) return false;
    if (!this.listening) {
      window.addEventListener("storage", this.handleStorage);
      this.listening = true;
    }
    this.heartbeat = window.setInterval(() => {
      if (this.read()?.owner !== this.owner) {
        this.lose();
        return;
      }
      this.write(Date.now());
    }, 2000);
    return true;
  }

  release(): void {
    window.clearInterval(this.heartbeat);
    if (this.listening) {
      window.removeEventListener("storage", this.handleStorage);
      this.listening = false;
    }
    const current = this.read();
    if (current?.owner === this.owner) localStorage.removeItem(this.key);
  }

  private readonly handleStorage = (event: StorageEvent): void => {
    if (event.key !== this.key) return;
    if (this.read()?.owner !== this.owner) this.lose();
  };

  private lose(): void {
    window.clearInterval(this.heartbeat);
    if (this.listening) {
      window.removeEventListener("storage", this.handleStorage);
      this.listening = false;
    }
    this.onLost?.();
  }

  private read(): TabLockValue | null {
    try {
      const raw = localStorage.getItem(this.key);
      return raw ? (JSON.parse(raw) as TabLockValue) : null;
    } catch {
      return null;
    }
  }

  private write(now: number): void {
    localStorage.setItem(this.key, JSON.stringify({ owner: this.owner, expiresAt: now + 15_000 }));
  }
}
