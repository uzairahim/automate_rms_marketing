/**
 * The SPA's one way of talking to the API.
 *
 * Everything goes through {@link apiFetch} so the session token is attached in a
 * single place and every failure arrives as the same {@link ApiError} — which is
 * what lets a screen show what the API actually said (a suspended Client, a
 * missing Page) instead of a generic "something went wrong".
 */

/** The session token, held for the tab. */
let sessionToken: string | null = localStorage.getItem("smma.session");

export function getSessionToken(): string | null {
  return sessionToken;
}

export function setSessionToken(token: string | null): void {
  sessionToken = token;
  if (token) localStorage.setItem("smma.session", token);
  else localStorage.removeItem("smma.session");
}

/** A non-2xx response, carrying the API's own error code and message. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

interface ApiErrorBody {
  error?: string;
  message?: string;
}

export async function apiFetch<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const response = await fetch(path, {
    method: init.method ?? "GET",
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(sessionToken ? { authorization: `Bearer ${sessionToken}` } : {}),
    },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
  });

  const text = await response.text();
  const body = text ? (JSON.parse(text) as unknown) : {};

  if (!response.ok) {
    const { error, message } = body as ApiErrorBody;
    throw new ApiError(
      response.status,
      error ?? "unknown_error",
      message ?? error ?? `Request failed (${response.status})`,
    );
  }
  return body as T;
}

export type Platform = "facebook" | "instagram" | "tiktok";

export interface ConnectedAccount {
  platform: Platform;
  status: "connected" | "disconnected" | "token_expired";
  externalId: string | null;
  displayName: string | null;
  connectedAt: string | null;
}

export interface FacebookPageChoice {
  id: string;
  name: string;
}

export const listConnections = () =>
  apiFetch<{ connections: ConnectedAccount[] }>("/api/connections").then((b) => b.connections);

export const startFacebookConnect = () =>
  apiFetch<{ authorizeUrl: string; state: string }>("/api/connections/facebook/start", {
    method: "POST",
  });

export const completeFacebookLogin = (state: string, code: string) =>
  apiFetch<{ pages: FacebookPageChoice[] }>("/api/connections/facebook/callback", {
    method: "POST",
    body: { state, code },
  });

export const selectFacebookPage = (state: string, pageId: string) =>
  apiFetch<{ connection: ConnectedAccount }>("/api/connections/facebook/select", {
    method: "POST",
    body: { state, pageId },
  });

/**
 * Provide a hand-pasted long-lived Facebook Page token (ADR 0008, Option E) — the
 * bring-your-own-token fallback for when our own app review is unavailable. It
 * lands in the same Connected Account slot an OAuth login would, and doubles as
 * the way to regenerate a token_expired Page. Meta only.
 */
export const provideFacebookToken = (token: string, pageId: string, displayName: string) =>
  apiFetch<{ connection: ConnectedAccount }>("/api/connections/facebook/token", {
    method: "POST",
    body: { token, pageId, displayName },
  });

/**
 * Connect Instagram. No redirect and no callback screen: an IG Business account
 * is reached through the already-connected Page, so this one call is the whole
 * flow (ADR 0005).
 */
export const connectInstagram = () =>
  apiFetch<{ connection: ConnectedAccount }>("/api/connections/instagram/connect", {
    method: "POST",
  });

export const startTikTokConnect = () =>
  apiFetch<{ authorizeUrl: string; state: string }>("/api/connections/tiktok/start", {
    method: "POST",
  });

/** Finish TikTok login. One step — TikTok authorizes one account, so it connects. */
export const completeTikTokLogin = (state: string, code: string) =>
  apiFetch<{ connection: ConnectedAccount }>("/api/connections/tiktok/callback", {
    method: "POST",
    body: { state, code },
  });

export const disconnectPlatform = (platform: Platform) =>
  apiFetch<{ connection: ConnectedAccount }>(`/api/connections/${platform}`, {
    method: "DELETE",
  });
