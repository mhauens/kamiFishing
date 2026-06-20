import type { Config, Context } from "@netlify/functions";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual
} from "node:crypto";

type Purpose = "login";

type SessionUser = {
  id: string;
  login: string;
  displayName: string;
  picture?: string;
};

type Session = {
  user: SessionUser;
  channelConnected: boolean;
  eventsubStatus?: string;
  rewardStatus?: string;
};

type OAuthState = {
  state: string;
  nonce: string;
  purpose: Purpose;
};

type TwitchToken = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: string[];
};

type TwitchTokenResponse = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope?: string[];
  id_token?: string;
};

type RewardSettings = {
  cost: number;
  globalCooldownSeconds: number;
  maxPerUserPerStream: number;
};

type TwitchReward = {
  id: string;
  title: string;
  cost: number;
  global_cooldown_setting: {
    is_enabled: boolean;
    global_cooldown_seconds: number;
  };
  max_per_user_per_stream_setting: {
    is_enabled: boolean;
    max_per_user_per_stream: number;
  };
};

const SESSION_COOKIE = "kami_session";
const TOKEN_COOKIE = "kami_twitch_token";
const OAUTH_COOKIE = "kami_oauth";
const REWARD_TITLE = "Ente in den Teich schicken";
const DEFAULT_REWARD: RewardSettings = {
  cost: 1000,
  globalCooldownSeconds: 10,
  maxPerUserPerStream: 1
};

export default async (req: Request, _context: Context) => {
  const url = new URL(req.url);
  const path = url.pathname;

  try {
    if (path === "/api/me" && req.method === "GET") return json(sessionPayload(readSession(req)));
    if (path === "/api/settings" && req.method === "GET") return json(defaultSettings());
    if (path === "/api/auth/logout" && req.method === "POST") return handleLogout();
    if (path === "/api/auth/twitch/start" && req.method === "GET") return handleOAuthStart(url);
    if (path === "/api/auth/twitch/callback" && req.method === "GET") return handleOAuthCallback(req, url);
    if (path === "/api/twitch/eventsub/session" && req.method === "POST") {
      return withTwitchToken(req, (session, token) => registerEventSubSession(req, session, token));
    }
    if (path === "/api/twitch/reward" && req.method === "GET") {
      return withTwitchToken(req, (session, token) => getRewardSettings(session, token));
    }
    if (path === "/api/twitch/reward" && req.method === "PATCH") {
      return withTwitchToken(req, (session, token) => patchRewardSettings(req, session, token));
    }
    if (path === "/api/twitch/redemptions" && req.method === "GET") {
      return withTwitchToken(req, (session, token) => getUnfulfilledRedemptions(session, token));
    }
    if (path === "/api/twitch/redemptions/fulfill" && req.method === "POST") {
      return withTwitchToken(req, (session, token) => fulfillRedemptions(req, session, token));
    }

    return new Response("Not found", { status: 404 });
  } catch (error) {
    console.error(error);
    const message = error instanceof Error ? error.message : "Internal server error";
    return json({ error: message }, { status: 500 });
  }
};

export const config: Config = {
  path: [
    "/api/me",
    "/api/settings",
    "/api/auth/logout",
    "/api/auth/twitch/start",
    "/api/auth/twitch/callback",
    "/api/twitch/eventsub/session",
    "/api/twitch/reward",
    "/api/twitch/redemptions",
    "/api/twitch/redemptions/fulfill"
  ]
};

function handleOAuthStart(url: URL): Response {
  const clientId = env("TWITCH_CLIENT_ID");
  const appBaseUrl = env("APP_BASE_URL");

  if (!clientId || !appBaseUrl) {
    return popupResult(false, "login", "Twitch OAuth ist noch nicht konfiguriert.");
  }

  const state: OAuthState = {
    state: randomToken(),
    nonce: randomToken(),
    purpose: "login"
  };

  const redirectUri = `${appBaseUrl.replace(/\/$/, "")}/api/auth/twitch/callback`;
  const scope = "openid channel:read:subscriptions channel:manage:redemptions user:read:chat";
  const authorize = new URL("https://id.twitch.tv/oauth2/authorize");
  authorize.searchParams.set("client_id", clientId);
  authorize.searchParams.set("redirect_uri", redirectUri);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("scope", scope);
  authorize.searchParams.set("state", state.state);
  authorize.searchParams.set("nonce", state.nonce);
  authorize.searchParams.set("force_verify", "true");

  return redirect(authorize.toString(), [
    cookie(OAUTH_COOKIE, signJson(state), {
      httpOnly: true,
      maxAge: 600,
      sameSite: "Lax"
    })
  ]);
}

async function handleOAuthCallback(req: Request, url: URL): Promise<Response> {
  const storedState = readSignedJson<OAuthState>(req, OAUTH_COOKIE);
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error_description") || url.searchParams.get("error");

  if (!storedState || !state || storedState.state !== state) {
    return popupResult(false, "login", "OAuth state mismatch.");
  }

  if (error || !code) {
    return popupResult(false, "login", error || "Kein OAuth Code erhalten.");
  }

  const exchanged = await exchangeCode(code);
  if (!exchanged.id_token) throw new Error("Twitch ID Token fehlt.");
  const claims = decodeJwtClaims(exchanged.id_token);
  const user: SessionUser = {
    id: String(claims.sub || ""),
    login: String(claims.preferred_username || claims.login || claims.sub || "twitch-user").toLowerCase(),
    displayName: String(claims.preferred_username || claims.login || "Twitch User"),
    picture: typeof claims.picture === "string" ? claims.picture : undefined
  };

  if (!user.id) {
    return popupResult(false, "login", "Twitch ID Token enthaelt keine User-ID.");
  }

  const token = tokenFromResponse(exchanged);
  let rewardStatus = "ready";
  try {
    await ensureReward(user.id, token.accessToken);
  } catch (rewardError) {
    rewardStatus = rewardError instanceof TwitchApiError ? `unavailable-${rewardError.status}` : "unavailable";
    if (!isAffiliateRequiredError(rewardError)) console.warn("Could not prepare Twitch reward", rewardError);
  }

  const nextSession: Session = {
    user,
    channelConnected: true,
    eventsubStatus: "websocket-ready",
    rewardStatus
  };

  return popupResult(true, "login", undefined, [
    cookie(SESSION_COOKIE, signJson(nextSession), sessionCookieOptions()),
    cookie(TOKEN_COOKIE, encryptJson(token), sessionCookieOptions()),
    cookie(OAUTH_COOKIE, "", { httpOnly: true, maxAge: 0, sameSite: "Lax" })
  ]);
}

function handleLogout(): Response {
  return json(
    { ok: true },
    {
      headers: cookieHeaders([
        cookie(SESSION_COOKIE, "", { httpOnly: true, maxAge: 0, sameSite: "Lax" }),
        cookie(TOKEN_COOKIE, "", { httpOnly: true, maxAge: 0, sameSite: "Lax" })
      ])
    }
  );
}

async function registerEventSubSession(req: Request, session: Session, token: TwitchToken): Promise<Response> {
  const body = (await req.json()) as { sessionId?: string };
  const sessionId = String(body.sessionId || "");
  if (!/^[A-Za-z0-9_-]{8,200}$/.test(sessionId)) return json({ error: "Invalid EventSub session ID." }, { status: 400 });

  let reward: TwitchReward | null = null;
  try {
    reward = await ensureReward(session.user.id, token.accessToken);
  } catch (error) {
    if (!isAffiliateRequiredError(error)) console.warn("Channel Points subscription unavailable", error);
  }

  const subscriptions: Array<{ type: string; version: string; condition: Record<string, string> }> = [
    {
      type: "channel.subscription.gift",
      version: "1",
      condition: { broadcaster_user_id: session.user.id }
    },
    {
      type: "channel.chat.message",
      version: "1",
      condition: { broadcaster_user_id: session.user.id, user_id: session.user.id }
    },
    ...(reward
      ? [
          {
            type: "channel.channel_points_custom_reward_redemption.add",
            version: "1",
            condition: { broadcaster_user_id: session.user.id, reward_id: reward.id }
          }
        ]
      : [])
  ];

  const results = await Promise.all(
    subscriptions.map((subscription) => createWebSocketSubscription(subscription, sessionId, token.accessToken))
  );
  return json({ subscriptions: results });
}

async function getRewardSettings(session: Session, token: TwitchToken): Promise<Response> {
  try {
    const reward = await ensureReward(session.user.id, token.accessToken);
    return json({ available: true, settings: rewardSettingsFromReward(reward) });
  } catch (error) {
    if (isAffiliateRequiredError(error)) return json({ available: false, reason: "affiliate-required" });
    throw error;
  }
}

async function patchRewardSettings(req: Request, session: Session, token: TwitchToken): Promise<Response> {
  const input = (await req.json()) as Partial<RewardSettings>;
  const settings = sanitizeRewardSettings(input);
  try {
    const reward = await ensureReward(session.user.id, token.accessToken, settings);
    return json({ available: true, settings: rewardSettingsFromReward(reward) });
  } catch (error) {
    if (isAffiliateRequiredError(error)) return json({ available: false, reason: "affiliate-required" });
    throw error;
  }
}

async function getUnfulfilledRedemptions(session: Session, token: TwitchToken): Promise<Response> {
  let reward: TwitchReward;
  try {
    reward = await ensureReward(session.user.id, token.accessToken);
  } catch (error) {
    if (isAffiliateRequiredError(error)) {
      return json({ redemptions: [], rewardAvailable: false, reason: "affiliate-required" });
    }
    throw error;
  }
  const url = new URL("https://api.twitch.tv/helix/channel_points/custom_rewards/redemptions");
  url.searchParams.set("broadcaster_id", session.user.id);
  url.searchParams.set("reward_id", reward.id);
  url.searchParams.set("status", "UNFULFILLED");
  url.searchParams.set("first", "50");
  const payload = await twitchApi<{ data: Array<Record<string, unknown>> }>(url, token.accessToken);

  return json({
    redemptions: payload.data.map((redemption) => ({
      id: String(redemption.id || ""),
      userId: String(redemption.user_id || ""),
      userName: String(redemption.user_name || redemption.user_login || "Twitch User"),
      redeemedAt: String(redemption.redeemed_at || "")
    }))
  });
}

async function fulfillRedemptions(req: Request, session: Session, token: TwitchToken): Promise<Response> {
  const input = (await req.json()) as { ids?: unknown };
  const ids = Array.isArray(input.ids)
    ? [...new Set(input.ids.map(String).filter((id) => /^[A-Za-z0-9-]{8,100}$/.test(id)))].slice(0, 50)
    : [];
  if (ids.length === 0) return json({ ok: true });

  let reward: TwitchReward;
  try {
    reward = await ensureReward(session.user.id, token.accessToken);
  } catch (error) {
    if (isAffiliateRequiredError(error)) return json({ ok: true, rewardAvailable: false });
    throw error;
  }
  const url = new URL("https://api.twitch.tv/helix/channel_points/custom_rewards/redemptions");
  url.searchParams.set("broadcaster_id", session.user.id);
  url.searchParams.set("reward_id", reward.id);
  for (const id of ids) url.searchParams.append("id", id);

  await twitchApi(url, token.accessToken, {
    method: "PATCH",
    body: JSON.stringify({ status: "FULFILLED" })
  });
  return json({ ok: true });
}

async function createWebSocketSubscription(
  subscription: { type: string; version: string; condition: Record<string, string> },
  sessionId: string,
  accessToken: string
): Promise<{ type: string; status: string }> {
  try {
    const payload = await twitchApi<{ data?: Array<{ status?: string }> }>(
      "https://api.twitch.tv/helix/eventsub/subscriptions",
      accessToken,
      {
        method: "POST",
        body: JSON.stringify({
          ...subscription,
          transport: {
            method: "websocket",
            session_id: sessionId
          }
        })
      }
    );
    return { type: subscription.type, status: payload.data?.[0]?.status || "enabled" };
  } catch (error) {
    if (error instanceof TwitchApiError && error.status === 409) {
      return { type: subscription.type, status: "already-exists" };
    }
    throw error;
  }
}

async function ensureReward(
  broadcasterId: string,
  accessToken: string,
  desiredSettings?: RewardSettings
): Promise<TwitchReward> {
  const settings = sanitizeRewardSettings(desiredSettings || DEFAULT_REWARD);
  const listUrl = new URL("https://api.twitch.tv/helix/channel_points/custom_rewards");
  listUrl.searchParams.set("broadcaster_id", broadcasterId);
  listUrl.searchParams.set("only_manageable_rewards", "true");
  const existing = await twitchApi<{ data: TwitchReward[] }>(listUrl, accessToken);
  const reward = existing.data.find((candidate) => candidate.title === REWARD_TITLE);
  const body = rewardRequestBody(settings);

  if (!reward) {
    const createUrl = new URL("https://api.twitch.tv/helix/channel_points/custom_rewards");
    createUrl.searchParams.set("broadcaster_id", broadcasterId);
    const created = await twitchApi<{ data: TwitchReward[] }>(createUrl, accessToken, {
      method: "POST",
      body: JSON.stringify({
        title: REWARD_TITLE,
        prompt: "Loest eine Ente mit deinem Twitch-Namen im Spiel aus.",
        background_color: "#FFD35E",
        is_user_input_required: false,
        should_redemptions_skip_request_queue: false,
        ...body
      })
    });
    if (!created.data[0]) throw new Error("Twitch reward creation returned no reward.");
    return created.data[0];
  }

  if (!desiredSettings || rewardSettingsEqual(rewardSettingsFromReward(reward), settings)) return reward;
  const updateUrl = new URL("https://api.twitch.tv/helix/channel_points/custom_rewards");
  updateUrl.searchParams.set("broadcaster_id", broadcasterId);
  updateUrl.searchParams.set("id", reward.id);
  const updated = await twitchApi<{ data: TwitchReward[] }>(updateUrl, accessToken, {
    method: "PATCH",
    body: JSON.stringify(body)
  });
  return updated.data[0] || reward;
}

function rewardRequestBody(settings: RewardSettings) {
  return {
    cost: settings.cost,
    global_cooldown_setting: {
      is_enabled: settings.globalCooldownSeconds > 0,
      global_cooldown_seconds: Math.max(1, settings.globalCooldownSeconds)
    },
    max_per_user_per_stream_setting: {
      is_enabled: settings.maxPerUserPerStream > 0,
      max_per_user_per_stream: Math.max(1, settings.maxPerUserPerStream)
    }
  };
}

function rewardSettingsFromReward(reward: TwitchReward): RewardSettings {
  return {
    cost: reward.cost,
    globalCooldownSeconds: reward.global_cooldown_setting.is_enabled
      ? reward.global_cooldown_setting.global_cooldown_seconds
      : 0,
    maxPerUserPerStream: reward.max_per_user_per_stream_setting.is_enabled
      ? reward.max_per_user_per_stream_setting.max_per_user_per_stream
      : 0
  };
}

function rewardSettingsEqual(left: RewardSettings, right: RewardSettings): boolean {
  return (
    left.cost === right.cost &&
    left.globalCooldownSeconds === right.globalCooldownSeconds &&
    left.maxPerUserPerStream === right.maxPerUserPerStream
  );
}

function sanitizeRewardSettings(input: Partial<RewardSettings>): RewardSettings {
  return {
    cost: clampInteger(input.cost, DEFAULT_REWARD.cost, 1, 1_000_000),
    globalCooldownSeconds: clampInteger(input.globalCooldownSeconds, DEFAULT_REWARD.globalCooldownSeconds, 0, 86_400),
    maxPerUserPerStream: clampInteger(input.maxPerUserPerStream, DEFAULT_REWARD.maxPerUserPerStream, 0, 100)
  };
}

async function withTwitchToken(
  req: Request,
  handler: (session: Session, token: TwitchToken) => Promise<Response>
): Promise<Response> {
  const session = readSession(req);
  const storedToken = readEncryptedJson<TwitchToken>(req, TOKEN_COOKIE);
  if (!session || !storedToken) return json({ error: "Nicht mit Twitch eingeloggt." }, { status: 401 });

  const { token, refreshed } = await refreshTokenIfNeeded(storedToken);
  const response = await handler(session, token);
  if (refreshed) response.headers.append("Set-Cookie", cookie(TOKEN_COOKIE, encryptJson(token), sessionCookieOptions()));
  return response;
}

async function refreshTokenIfNeeded(token: TwitchToken): Promise<{ token: TwitchToken; refreshed: boolean }> {
  if (token.expiresAt > Date.now() + 60_000) return { token, refreshed: false };
  const response = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: token.refreshToken,
      client_id: requiredEnv("TWITCH_CLIENT_ID"),
      client_secret: requiredEnv("TWITCH_CLIENT_SECRET")
    })
  });
  if (!response.ok) throw new Error(`Twitch token refresh failed: ${response.status}`);
  const refreshed = (await response.json()) as TwitchTokenResponse;
  return {
    token: tokenFromResponse({
      ...refreshed,
      refresh_token: refreshed.refresh_token || token.refreshToken,
      scope: refreshed.scope || token.scopes
    }),
    refreshed: true
  };
}

async function exchangeCode(code: string): Promise<TwitchTokenResponse> {
  const appBaseUrl = requiredEnv("APP_BASE_URL").replace(/\/$/, "");
  const response = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: requiredEnv("TWITCH_CLIENT_ID"),
      client_secret: requiredEnv("TWITCH_CLIENT_SECRET"),
      code,
      grant_type: "authorization_code",
      redirect_uri: `${appBaseUrl}/api/auth/twitch/callback`
    })
  });
  if (!response.ok) throw new Error(`Twitch token exchange failed: ${response.status}`);
  return (await response.json()) as TwitchTokenResponse;
}

function tokenFromResponse(response: TwitchTokenResponse): TwitchToken {
  return {
    accessToken: response.access_token,
    refreshToken: response.refresh_token,
    expiresAt: Date.now() + Math.max(60, response.expires_in) * 1000,
    scopes: response.scope || []
  };
}

class TwitchApiError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

function isAffiliateRequiredError(error: unknown): boolean {
  return error instanceof TwitchApiError && error.status === 403 && error.message.toLowerCase().includes("partner or affiliate");
}

async function twitchApi<T = unknown>(url: string | URL, accessToken: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Client-Id": requiredEnv("TWITCH_CLIENT_ID"),
      "Content-Type": "application/json",
      ...init.headers
    }
  });
  if (!response.ok) {
    const text = await response.text();
    throw new TwitchApiError(response.status, `Twitch API ${response.status}: ${text}`);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

function sessionPayload(session: Session | null) {
  if (!session) return { authenticated: false, channelConnected: false };
  return {
    authenticated: true,
    channelConnected: session.channelConnected,
    eventsubStatus: session.eventsubStatus,
    rewardStatus: session.rewardStatus,
    user: session.user
  };
}

function defaultSettings() {
  return {
    subsPerDuck: intEnv("DEFAULT_SUBS_PER_DUCK", 5),
    specialSubsPerDuck: intEnv("DEFAULT_SPECIAL_SUBS_PER_DUCK", 10),
    guestDuckIntervalSeconds: intEnv("DEFAULT_GUEST_DUCK_INTERVAL_SECONDS", 12),
    twitchIdleDuckSeconds: intEnv("DEFAULT_TWITCH_IDLE_DUCK_SECONDS", 60),
    rewardCost: intEnv("DEFAULT_REWARD_COST", 1000),
    rewardCooldownSeconds: intEnv("DEFAULT_REWARD_COOLDOWN_SECONDS", 10),
    rewardMaxPerUserPerStream: intEnv("DEFAULT_REWARD_MAX_PER_USER_PER_STREAM", 1)
  };
}

function readSession(req: Request): Session | null {
  return readSignedJson<Session>(req, SESSION_COOKIE);
}

function readSignedJson<T>(req: Request, name: string): T | null {
  const value = parseCookies(req.headers.get("cookie") || "")[name];
  if (!value) return null;
  const [body, signature] = value.split(".");
  if (!body || !signature || !safeEqual(signature, hmac(body))) return null;
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T;
  } catch {
    return null;
  }
}

function signJson(value: unknown): string {
  const body = Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${body}.${hmac(body)}`;
}

function encryptJson(value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString("base64url")).join(".");
}

function readEncryptedJson<T>(req: Request, name: string): T | null {
  const value = parseCookies(req.headers.get("cookie") || "")[name];
  if (!value) return null;
  const [ivValue, tagValue, encryptedValue] = value.split(".");
  if (!ivValue || !tagValue || !encryptedValue) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivValue, "base64url"));
    decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(encryptedValue, "base64url")),
      decipher.final()
    ]).toString("utf8");
    return JSON.parse(decrypted) as T;
  } catch {
    return null;
  }
}

function encryptionKey(): Buffer {
  return createHash("sha256").update(requiredEnv("SESSION_SECRET")).digest();
}

function hmac(value: string): string {
  return createHmac("sha256", requiredEnv("SESSION_SECRET")).update(value).digest("base64url");
}

function parseCookies(header: string): Record<string, string> {
  return Object.fromEntries(
    header
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const [key, ...rest] = part.split("=");
        return [key, decodeURIComponent(rest.join("="))];
      })
  );
}

function sessionCookieOptions() {
  return { httpOnly: true, maxAge: 60 * 60 * 24 * 14, sameSite: "Lax" as const };
}

function cookie(
  name: string,
  value: string,
  options: { httpOnly?: boolean; maxAge?: number; sameSite?: "Lax" | "Strict" | "None" }
): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/", `SameSite=${options.sameSite || "Lax"}`];
  if (options.httpOnly) parts.push("HttpOnly");
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
  if (env("APP_BASE_URL")?.startsWith("https://")) parts.push("Secure");
  return parts.join("; ");
}

function cookieHeaders(cookies: string[]): Headers {
  const headers = new Headers();
  for (const value of cookies) headers.append("Set-Cookie", value);
  return headers;
}

function popupResult(ok: boolean, purpose: Purpose, error?: string, cookies: string[] = []): Response {
  const data = JSON.stringify({ type: "kami:twitch-auth", ok, purpose, error });
  const headers = new Headers({ "Content-Type": "text/html; charset=utf-8" });
  for (const nextCookie of cookies) headers.append("Set-Cookie", nextCookie);
  return new Response(
    `<!doctype html><html><body><script>
      if (window.opener) window.opener.postMessage(${data}, window.location.origin);
      window.close();
      document.body.textContent = ${JSON.stringify(ok ? "Twitch verbunden. Dieses Fenster kann geschlossen werden." : error || "Twitch Login fehlgeschlagen.")};
    </script></body></html>`,
    { status: 200, headers }
  );
}

function redirect(location: string, setCookies: string[]): Response {
  const headers = new Headers({ Location: location });
  for (const nextCookie of setCookies) headers.append("Set-Cookie", nextCookie);
  return new Response(null, { status: 302, headers });
}

function json(value: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  return Response.json(value, { ...init, headers });
}

function decodeJwtClaims(token: string): Record<string, unknown> {
  const [, payload] = token.split(".");
  if (!payload) return {};
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
}

function randomToken(): string {
  return randomBytes(24).toString("base64url");
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function intEnv(name: string, fallback: number): number {
  return clampInteger(env(name), fallback, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
}

function requiredEnv(name: string): string {
  const value = env(name);
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function env(name: string): string | undefined {
  const netlifyGlobal = globalThis as typeof globalThis & {
    Netlify?: { env: { get(name: string): string | undefined } };
  };
  return netlifyGlobal.Netlify?.env.get(name) || process.env[name];
}
