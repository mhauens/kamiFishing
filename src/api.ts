import type { GameSettings, GiftEvent, UserSession } from "./types";

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

export async function fetchGiftEvents(since: number): Promise<GiftEvent[]> {
  const response = await fetch(`/api/ducks?since=${encodeURIComponent(String(since))}`, {
    credentials: "same-origin"
  });
  if (!isJsonResponse(response)) return [];
  const payload = (await response.json()) as { events: GiftEvent[] };
  return payload.events;
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

function isJsonResponse(response: Response): boolean {
  return response.ok && response.headers.get("content-type")?.includes("application/json") === true;
}
