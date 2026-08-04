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
