import type { FastifyReply, FastifyRequest } from "fastify";
import { ADMIN_SESSION_TTL_MS } from "./superadmins.js";

/**
 * How an operator's session travels — an httpOnly, `Secure`, `SameSite=Strict`
 * cookie, set by the API and never touched by the SPA (ADR 0010).
 *
 * This deliberately differs from the Client SPA's `localStorage` bearer token.
 * That credential reaches one Client; this one can suspend every Client on the
 * platform, so a single injection flaw in the panel must not be able to read it.
 * `SameSite=Strict` plus same-origin serving is also what covers CSRF here
 * without a second token to carry around.
 */
export const ADMIN_SESSION_COOKIE = "smma_admin_session";

/** The attributes every set of this cookie carries, whether opening or clearing. */
function cookieOptions(secure: boolean) {
  return {
    httpOnly: true,
    secure,
    sameSite: "strict" as const,
    path: "/",
  };
}

export function setSessionCookie(reply: FastifyReply, token: string, secure: boolean): void {
  reply.setCookie(ADMIN_SESSION_COOKIE, token, {
    ...cookieOptions(secure),
    // Matches the session's own TTL, so the browser drops a cookie the server
    // would refuse anyway rather than sending a credential that cannot work.
    maxAge: Math.floor(ADMIN_SESSION_TTL_MS / 1000),
  });
}

export function clearSessionCookie(reply: FastifyReply, secure: boolean): void {
  reply.clearCookie(ADMIN_SESSION_COOKIE, cookieOptions(secure));
}

/** The session token presented on the request, or "" if none. */
export function sessionToken(request: FastifyRequest): string {
  return request.cookies[ADMIN_SESSION_COOKIE] ?? "";
}
