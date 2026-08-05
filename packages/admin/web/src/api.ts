/**
 * The panel's one way of talking to the admin API.
 *
 * Note what is absent: any handling of a session token. The session lives in an
 * httpOnly cookie the browser attaches by itself, so there is nothing here to
 * read it out of, nothing to put in `localStorage`, and nothing for an injected
 * script to steal (ADR 0010). `credentials: "same-origin"` is the whole of it.
 */

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

export async function apiFetch<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const response = await fetch(path, {
    method: init.method ?? "GET",
    credentials: "same-origin",
    headers: init.body ? { "content-type": "application/json" } : {},
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
  });

  const text = await response.text();
  const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};

  if (!response.ok) {
    const code = typeof body.error === "string" ? body.error : "unknown_error";
    const message = typeof body.message === "string" ? body.message : null;
    throw new ApiError(response.status, code, message ?? messageFor(code, response.status));
  }
  return body as T;
}

/** What to say when the API sent a code but no prose — the operator's words. */
function messageFor(code: string, status: number): string {
  if (code === "invalid_credentials") return "That email and password did not match.";
  if (code === "unauthorized") return "Your session has ended. Please sign in again.";
  return `Request failed (${status}).`;
}

/**
 * Whether a request failed because the session is gone rather than because the
 * operator did something wrong. Every authenticated screen asks this, since the
 * two need opposite responses: one is a message, the other is the sign-in form.
 */
export const isSessionEnded = (err: unknown) => err instanceof ApiError && err.status === 401;

/** Who is signed in. Deliberately not a session object — there is no token here. */
export interface Superadmin {
  id: string;
  email: string;
}

export const signIn = (email: string, password: string) =>
  apiFetch<{ superadmin: Superadmin }>("/api/auth/login", {
    method: "POST",
    body: { email, password },
  }).then((b) => b.superadmin);

export const signOut = () => apiFetch<void>("/api/auth/logout", { method: "POST" });

/** The "am I still signed in?" probe the panel runs on load. */
export const whoAmI = () =>
  apiFetch<{ superadmin: Superadmin }>("/api/me").then((b) => b.superadmin);

/* ------------------------------------------------------------------ Clients */

/*
 * The wire shapes, restated rather than imported: `@smma/core` owns what a
 * Client *is*, but it reaches Postgres and cannot be bundled into a browser, so
 * the panel describes what the API sends — exactly as the Client SPA does. The
 * suites are what keep these honest, since they assert on the same responses.
 */

export type Platform = "facebook" | "instagram" | "tiktok";

export type AccessStatus = "active" | "suspended" | "expired";

/** The Superadmin-configured bundle: what a Client may use, and whether at all. */
export interface Plan extends Record<Platform, boolean> {
  accessStatus: AccessStatus;
}

export interface Client {
  id: string;
  subdomain: string;
  timezone: string;
  createdAt: string;
  plan: Plan;
}

/**
 * Whether a Client's access has lapsed — its access status is not `active`
 * (CONTEXT.md `Plan`). Suspended and expired are one thing to an operator
 * scanning the list, and the one thing the list must not bury.
 */
export const hasLapsed = (client: Client) => client.plan.accessStatus !== "active";

/** Every Client on the platform, newest first. No paging: this is the whole view. */
export const listClients = () =>
  apiFetch<{ clients: Client[] }>("/api/clients").then((b) => b.clients);

export const getClient = (clientId: string) =>
  apiFetch<{ client: Client }>(`/api/clients/${clientId}`).then((b) => b.client);

/**
 * Provision a Client. Access status is deliberately absent: a new Client is
 * always active, and there is nothing to ask the operator about.
 */
export const createClient = (input: {
  subdomain: string;
  timezone: string;
  plan: Record<Platform, boolean>;
}) =>
  apiFetch<{ client: Client }>("/api/clients", { method: "POST", body: input }).then(
    (b) => b.client,
  );
