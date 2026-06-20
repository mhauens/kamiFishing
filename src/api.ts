import type { GameSettings, RewardSettings, UserSession } from "./types";

export type TwitchRedemption = {
  id: string;
  userId: string;
  userName: string;
  redeemedAt: string;
};

export type RewardAvailability = {
  available: boolean;
  reason?: "affiliate-required" | "unavailable";
  settings?: RewardSettings;
};

export async function fetchSession(): Promise<UserSession> {
  const response = await fetch("/api/me", { credentials: "same-origin" });
  if (!isJsonResponse(response)) return { authenticated: false, channelConnected: false };
  return (await response.json()) as UserSession;
}

export async function fetchServerSettings(): Promise<Partial<GameSettings>> {
  const response = await fetch("/api/settings", { credentials: "same-origin" });
  if (!isJsonResponse(response)) return {};
  return (await response.json()) as Partial<GameSettings>;
}

export async function registerTwitchEventSubSession(sessionId: string): Promise<void> {
  await jsonRequest("/api/twitch/eventsub/session", {
    method: "POST",
    body: JSON.stringify({ sessionId })
  });
}

export async function fetchRewardSettings(): Promise<RewardAvailability | null> {
  const response = await fetch("/api/twitch/reward", { credentials: "same-origin" });
  if (!isJsonResponse(response)) return null;
  return (await response.json()) as RewardAvailability;
}

export async function updateRewardSettings(settings: RewardSettings): Promise<RewardSettings> {
  const result = (await jsonRequest("/api/twitch/reward", {
    method: "PATCH",
    body: JSON.stringify(settings)
  })) as RewardAvailability;
  if (!result.available || !result.settings) {
    throw new Error(result.reason === "affiliate-required" ? "Kanalpunkte benötigen Twitch Affiliate oder Partner." : "Kanalpunkte nicht verfügbar.");
  }
  return result.settings;
}

export async function fetchUnfulfilledRedemptions(): Promise<TwitchRedemption[]> {
  const response = await fetch("/api/twitch/redemptions", { credentials: "same-origin" });
  if (!isJsonResponse(response)) return [];
  const payload = (await response.json()) as { redemptions: TwitchRedemption[] };
  return payload.redemptions;
}

export async function fulfillRedemptions(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await jsonRequest("/api/twitch/redemptions/fulfill", {
    method: "POST",
    body: JSON.stringify({ ids })
  });
}

export async function logout(): Promise<void> {
  await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
}

export function openTwitchPopup(purpose: "login"): void {
  const width = 520;
  const height = 720;
  const left = window.screenX + Math.max(0, (window.outerWidth - width) / 2);
  const top = window.screenY + Math.max(0, (window.outerHeight - height) / 2);
  window.open(
    `/api/auth/twitch/start?purpose=${encodeURIComponent(purpose)}`,
    "kamiFishingTwitch",
    `popup=yes,width=${width},height=${height},left=${left},top=${top}`
  );
}

async function jsonRequest(path: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...init.headers
    }
  });
  if (!isJsonResponse(response)) {
    const text = await response.text();
    throw new Error(text || `Request failed: ${response.status}`);
  }
  return response.json();
}

function isJsonResponse(response: Response): boolean {
  return response.ok && response.headers.get("content-type")?.includes("application/json") === true;
}
