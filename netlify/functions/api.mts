import type { Config, Context } from "@netlify/functions";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

type Purpose = "login" | "connect-channel";

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
};

type OAuthState = {
  state: string;
  nonce: string;
  purpose: Purpose;
};

type GiftEvent = {
  id: string;
  at: number;
  displayName: string;
  total: number;
  anonymous: boolean;
};

const SESSION_COOKIE = "kami_session";
const OAUTH_COOKIE = "kami_oauth";
const HMAC_PREFIX = "sha256=";
const giftEvents: GiftEvent[] = [];
const seenEventSubMessages = new Set<string>();

export default async (req: Request, context: Context) => {
  const url = new URL(req.url);
  const path = url.pathname;

  try {
    if (path === "/api/me" && req.method === "GET") return json(sessionPayload(readSession(req)));
    if (path === "/api/settings" && req.method === "GET") return json(defaultSettings());
    if (path === "/api/ducks" && req.method === "GET") return handleDucks(url);
    if (path === "/api/auth/logout" && req.method === "POST") return handleLogout();
    if (path === "/api/auth/twitch/start" && req.method === "GET") return handleOAuthStart(url);
    if (path === "/api/auth/twitch/callback" && req.method === "GET") return handleOAuthCallback(req, url);
    if (path === "/api/twitch/eventsub" && req.method === "POST") return handleEventSub(req);

    return new Response("Not found", { status: 404 });
  } catch (error) {
    console.error(error);
    return new Response("Internal server error", { status: 500 });
  }
};

export const config: Config = {
  path: [
    "/api/me",
    "/api/settings",
    "/api/ducks",
    "/api/auth/logout",
    "/api/auth/twitch/start",
    "/api/auth/twitch/callback",
    "/api/twitch/eventsub"
  ]
};

function handleOAuthStart(url: URL): Response {
  const purpose = parsePurpose(url.searchParams.get("purpose"));
  const clientId = env("TWITCH_CLIENT_ID");
  const appBaseUrl = env("APP_BASE_URL");

  if (!clientId || !appBaseUrl) {
    return popupResult(false, purpose, "Twitch OAuth ist noch nicht konfiguriert.");
  }

  const state: OAuthState = {
    state: randomToken(),
    nonce: randomToken(),
    purpose
  };

  const redirectUri = `${appBaseUrl.replace(/\/$/, "")}/api/auth/twitch/callback`;
  const scope = "openid channel:read:subscriptions";
  const authorize = new URL("https://id.twitch.tv/oauth2/authorize");
  authorize.searchParams.set("client_id", clientId);
  authorize.searchParams.set("redirect_uri", redirectUri);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("scope", scope);
  authorize.searchParams.set("state", state.state);
  authorize.searchParams.set("nonce", state.nonce);

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
    return popupResult(false, storedState.purpose, error || "Kein OAuth Code erhalten.");
  }

  const token = await exchangeCode(code);
  const claims = decodeJwtClaims(token.id_token);
  const user: SessionUser = {
    id: String(claims.sub || ""),
    login: String(claims.preferred_username || claims.login || claims.sub || "twitch-user").toLowerCase(),
    displayName: String(claims.preferred_username || claims.login || "Twitch User"),
    picture: typeof claims.picture === "string" ? claims.picture : undefined
  };

  if (!user.id) {
    return popupResult(false, storedState.purpose, "Twitch ID Token enthaelt keine User-ID.");
  }

  const currentSession = readSession(req);
  if (storedState.purpose === "connect-channel" && currentSession?.user.id !== user.id) {
    return popupResult(false, storedState.purpose, "Der Kanal muss zum eingeloggten Twitch-User passen.");
  }

  const result = await createGiftSubSubscription(user.id);
  const eventsubStatus = result;
  const channelConnected = result === "enabled" || result === "webhook_callback_verification_pending" || result === "already-exists";

  const nextSession: Session = {
    user,
    channelConnected,
    eventsubStatus
  };

  return popupResult(true, storedState.purpose, undefined, [
    cookie(SESSION_COOKIE, signJson(nextSession), {
      httpOnly: true,
      maxAge: 60 * 60 * 24 * 14,
      sameSite: "Lax"
    }),
    cookie(OAUTH_COOKIE, "", { httpOnly: true, maxAge: 0, sameSite: "Lax" })
  ]);
}

function handleLogout(): Response {
  return json(
    { ok: true },
    {
      headers: {
        "Set-Cookie": cookie(SESSION_COOKIE, "", { httpOnly: true, maxAge: 0, sameSite: "Lax" })
      }
    }
  );
}

function handleDucks(url: URL): Response {
  pruneGiftEvents();
  const since = Number(url.searchParams.get("since") || 0);
  const events = giftEvents.filter((event) => event.at > since).slice(-25);
  return json({ events });
}

async function handleEventSub(req: Request): Promise<Response> {
  const rawBody = await req.text();
  const secret = env("EVENTSUB_SECRET");
  if (!secret) return new Response("Missing EVENTSUB_SECRET", { status: 500 });

  if (!verifyTwitchSignature(req, rawBody, secret)) {
    return new Response("Forbidden", { status: 403 });
  }

  const payload = JSON.parse(rawBody) as {
    challenge?: string;
    subscription?: { type?: string; status?: string };
    event?: Record<string, unknown>;
  };
  const messageType = req.headers.get("twitch-eventsub-message-type");
  const messageId = req.headers.get("twitch-eventsub-message-id") || randomToken();

  if (messageType === "webhook_callback_verification") {
    return new Response(payload.challenge || "", {
      status: 200,
      headers: { "Content-Type": "text/plain" }
    });
  }

  if (messageType === "revocation") {
    console.warn("Twitch EventSub revoked", payload.subscription?.status);
    return new Response(null, { status: 204 });
  }

  if (messageType !== "notification") {
    return new Response(null, { status: 204 });
  }

  if (seenEventSubMessages.has(messageId)) {
    return new Response(null, { status: 204 });
  }
  seenEventSubMessages.add(messageId);

  if (payload.subscription?.type === "channel.subscription.gift" && payload.event) {
    const event = payload.event;
    const anonymous = Boolean(event.is_anonymous);
    const displayName = anonymous
      ? "Anonymous"
      : String(event.user_name || event.user_login || event.gifter_user_name || event.gifter_user_login || "Anonymous");
    const total = Number(event.total || event.gift_total || event.amount || 1);

    giftEvents.push({
      id: messageId,
      at: Date.now(),
      displayName,
      total: Number.isFinite(total) ? total : 1,
      anonymous
    });
    pruneGiftEvents();
  }

  return new Response(null, { status: 204 });
}

async function exchangeCode(code: string): Promise<{ access_token: string; id_token: string }> {
  const clientId = requiredEnv("TWITCH_CLIENT_ID");
  const clientSecret = requiredEnv("TWITCH_CLIENT_SECRET");
  const appBaseUrl = requiredEnv("APP_BASE_URL").replace(/\/$/, "");
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    grant_type: "authorization_code",
    redirect_uri: `${appBaseUrl}/api/auth/twitch/callback`
  });

  const response = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });

  if (!response.ok) {
    throw new Error(`Twitch token exchange failed: ${response.status}`);
  }

  return (await response.json()) as { access_token: string; id_token: string };
}

async function createGiftSubSubscription(broadcasterUserId: string): Promise<string> {
  const clientId = env("TWITCH_CLIENT_ID");
  const clientSecret = env("TWITCH_CLIENT_SECRET");
  const appBaseUrl = env("APP_BASE_URL");
  const eventsubSecret = env("EVENTSUB_SECRET");

  if (!clientId || !clientSecret || !appBaseUrl || !eventsubSecret) return "not-configured";

  const tokenResponse = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "client_credentials"
    })
  });

  if (!tokenResponse.ok) return "app-token-failed";
  const token = (await tokenResponse.json()) as { access_token: string };
  const callback = `${appBaseUrl.replace(/\/$/, "")}/api/twitch/eventsub`;

  const response = await fetch("https://api.twitch.tv/helix/eventsub/subscriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      "Client-Id": clientId,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      type: "channel.subscription.gift",
      version: "1",
      condition: { broadcaster_user_id: broadcasterUserId },
      transport: {
        method: "webhook",
        callback,
        secret: eventsubSecret
      }
    })
  });

  if (response.status === 409) return "already-exists";
  if (!response.ok) return `eventsub-failed-${response.status}`;

  const payload = (await response.json()) as { data?: Array<{ status?: string }> };
  return payload.data?.[0]?.status || "enabled";
}

function verifyTwitchSignature(req: Request, rawBody: string, secret: string): boolean {
  const id = req.headers.get("twitch-eventsub-message-id");
  const timestamp = req.headers.get("twitch-eventsub-message-timestamp");
  const signature = req.headers.get("twitch-eventsub-message-signature");
  if (!id || !timestamp || !signature) return false;

  const message = id + timestamp + rawBody;
  const expected = HMAC_PREFIX + createHmac("sha256", secret).update(message).digest("hex");
  return safeEqual(expected, signature);
}

function sessionPayload(session: Session | null) {
  if (!session) return { authenticated: false, channelConnected: false };
  return {
    authenticated: true,
    channelConnected: session.channelConnected,
    eventsubStatus: session.eventsubStatus,
    user: session.user
  };
}

function defaultSettings() {
  return {
    subsPerDuck: intEnv("DEFAULT_SUBS_PER_DUCK", 5),
    specialSubsPerDuck: intEnv("DEFAULT_SPECIAL_SUBS_PER_DUCK", 10),
    guestDuckIntervalSeconds: intEnv("DEFAULT_GUEST_DUCK_INTERVAL_SECONDS", 12),
    twitchIdleDuckSeconds: intEnv("DEFAULT_TWITCH_IDLE_DUCK_SECONDS", 60),
    duckEventPollSeconds: intEnv("DUCK_EVENT_POLL_SECONDS", 15)
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
    const json = Buffer.from(body, "base64url").toString("utf8");
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

function signJson(value: unknown): string {
  const body = Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${body}.${hmac(body)}`;
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

function cookie(
  name: string,
  value: string,
  options: { httpOnly?: boolean; maxAge?: number; sameSite?: "Lax" | "Strict" | "None" }
): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/", options.sameSite ? `SameSite=${options.sameSite}` : "SameSite=Lax"];
  if (options.httpOnly) parts.push("HttpOnly");
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
  if (env("APP_BASE_URL")?.startsWith("https://")) parts.push("Secure");
  return parts.join("; ");
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
    {
      status: 200,
      headers
    }
  );
}

function redirect(location: string, setCookies: string[]): Response {
  const headers = new Headers({ Location: location });
  for (const nextCookie of setCookies) headers.append("Set-Cookie", nextCookie);
  return new Response(null, {
    status: 302,
    headers
  });
}

function json(value: unknown, init: ResponseInit = {}): Response {
  return Response.json(value, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init.headers
    }
  });
}

function parsePurpose(value: string | null): Purpose {
  return value === "connect-channel" ? "connect-channel" : "login";
}

function decodeJwtClaims(token: string): Record<string, unknown> {
  const [, payload] = token.split(".");
  if (!payload) return {};
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
}

function pruneGiftEvents(): void {
  const cutoff = Date.now() - 30 * 60 * 1000;
  while (giftEvents.length > 0 && giftEvents[0].at < cutoff) giftEvents.shift();
  while (giftEvents.length > 100) giftEvents.shift();
  while (seenEventSubMessages.size > 500) {
    const first = seenEventSubMessages.values().next().value as string | undefined;
    if (!first) break;
    seenEventSubMessages.delete(first);
  }
}

function randomToken(): string {
  return randomBytes(24).toString("base64url");
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function intEnv(name: string, fallback: number): number {
  const value = Number(env(name));
  return Number.isFinite(value) ? value : fallback;
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
