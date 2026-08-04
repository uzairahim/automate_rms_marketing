import type { FastifyInstance } from "fastify";
import {
  AdminAuthError,
  authenticateSuperadmin,
  endAdminSession,
  type Superadmin,
} from "../auth/superadmins.js";
import {
  clearSessionCookie,
  sessionToken,
  setSessionCookie,
} from "../auth/session-cookie.js";
import { authenticateAdminRequest } from "../auth/guards.js";

/**
 * The operator's front door: log in, stay logged in, log out.
 *
 * The session token appears in exactly one place — the `Set-Cookie` header — and
 * never in a response body, so the SPA has no way to hold it and no way to leak
 * it. What comes back is only who you are.
 */

function superadminView(superadmin: Superadmin) {
  return { id: superadmin.id, email: superadmin.email };
}

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: { email?: string; password?: string } }>(
    "/api/auth/login",
    async (request, reply) => {
      const { email, password } = request.body ?? {};
      if (typeof email !== "string" || typeof password !== "string") {
        return reply
          .code(400)
          .send({ error: "invalid_body", message: "email and password are required." });
      }

      try {
        const { token, superadmin } = await authenticateSuperadmin(
          app.adminDeps.pool,
          app.adminDeps.clock,
          { email, password },
        );
        setSessionCookie(reply, token, app.adminDeps.cookieSecure);
        return reply.code(200).send({ superadmin: superadminView(superadmin) });
      } catch (err) {
        if (err instanceof AdminAuthError) {
          // Identical for an unknown email and a wrong password: the form must
          // not be usable to discover which operator accounts exist.
          return reply.code(401).send({ error: err.code });
        }
        throw err;
      }
    },
  );

  // Ending a session on a shared machine. Deliberately not authenticated: a
  // caller holding a token may always destroy it, and refusing to log out an
  // already-expired session would only strand the cookie in the browser.
  app.post("/api/auth/logout", async (request, reply) => {
    const token = sessionToken(request);
    if (token) await endAdminSession(app.adminDeps.pool, token);
    clearSessionCookie(reply, app.adminDeps.cookieSecure);
    return reply.code(204).send();
  });

  // The SPA's "am I still signed in?" probe, and the shell's identity line.
  app.get("/api/me", async (request, reply) => {
    const superadmin = await authenticateAdminRequest(request, reply);
    if (!superadmin) return reply;

    return reply.code(200).send({ superadmin: superadminView(superadmin) });
  });
}
