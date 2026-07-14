import type { FastifyInstance } from "fastify";
import { AuthError, login } from "../auth/sessions.js";
import {
  accessDenied,
  authenticateClientRequest,
  resolveClientForRequest,
} from "../auth/guards.js";
import type { Client } from "../tenancy/clients.js";

/**
 * Client-facing authentication (PRD stories 14, 17): a User logs in with email +
 * password on their Client's subdomain and reaches their workspace.
 *
 * Every route resolves the tenant from the request subdomain first. Login is
 * scoped to that Client, so a User can only authenticate against the Client they
 * belong to. Access status gates login entirely (Slice 3): a suspended/expired
 * Client is refused with a clear reason before credentials are even checked, and
 * `/api/me` (the "reached the workspace" probe) is refused the same way.
 */

/** The Client fields the SPA needs — its identity, timezone, and Plan gating. */
function clientView(client: Client) {
  return {
    id: client.id,
    subdomain: client.subdomain,
    timezone: client.timezone,
    plan: client.plan,
  };
}

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: { email?: string; password?: string } }>(
    "/api/auth/login",
    async (request, reply) => {
      const client = await resolveClientForRequest(request, reply);
      if (!client) return reply;

      // Access status gates login entirely: a suspended/expired Client is refused
      // with its specific reason regardless of whether the credentials are valid.
      const denied = accessDenied(client.plan.accessStatus);
      if (denied) return reply.code(403).send(denied);

      const { email, password } = request.body ?? {};
      if (typeof email !== "string" || typeof password !== "string") {
        return reply
          .code(400)
          .send({ error: "invalid_body", message: "email and password are required." });
      }

      try {
        const { token, user } = await login(app.deps.pool, app.deps.clock, {
          clientId: client.id,
          email,
          password,
        });
        return reply.code(200).send({
          token,
          user: { id: user.id, email: user.email },
          client: clientView(client),
        });
      } catch (err) {
        if (err instanceof AuthError) {
          return reply.code(401).send({ error: err.code });
        }
        throw err;
      }
    },
  );

  app.get("/api/me", async (request, reply) => {
    const ctx = await authenticateClientRequest(request, reply);
    if (!ctx) return reply;

    return reply.code(200).send({
      user: { id: ctx.user.id, email: ctx.user.email },
      client: clientView(ctx.client),
    });
  });
}
