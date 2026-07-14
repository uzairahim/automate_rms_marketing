import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { resolveSurface } from "../tenancy/subdomain.js";
import { findClientBySubdomain, type Client } from "../tenancy/clients.js";
import { AuthError, login, resolveSession } from "../auth/sessions.js";

/**
 * Client-facing authentication (PRD story 14): a User logs in with email +
 * password on their Client's subdomain and reaches their workspace.
 *
 * Every route here resolves the tenant from the request subdomain first. Login
 * is scoped to that Client, so a User can only authenticate against the Client
 * they belong to; presenting the same credentials on another Client's subdomain
 * fails as bad credentials. `/api/me` is the "reached the workspace" probe: it
 * returns the session's User and Client, and rejects a session that does not
 * belong to the subdomain it is presented on.
 */

/** Resolve the Client for the request subdomain, or reply 404 and return null. */
async function resolveClientForRequest(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<Client | null> {
  const app = request.server;
  const surface = resolveSurface(request.headers.host, app.deps.baseDomain);
  if (surface.kind !== "client") {
    await reply.code(404).send({ error: "unknown_client" });
    return null;
  }
  const client = await findClientBySubdomain(app.deps.pool, surface.subdomain);
  if (!client) {
    await reply.code(404).send({ error: "unknown_client" });
    return null;
  }
  return client;
}

function bearerToken(request: FastifyRequest): string {
  const header = request.headers.authorization ?? "";
  return header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
}

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: { email?: string; password?: string } }>(
    "/api/auth/login",
    async (request, reply) => {
      const client = await resolveClientForRequest(request, reply);
      if (!client) return reply;

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
          client: { id: client.id, subdomain: client.subdomain, timezone: client.timezone },
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
    const client = await resolveClientForRequest(request, reply);
    if (!client) return reply;

    const token = bearerToken(request);
    if (!token) return reply.code(401).send({ error: "unauthorized" });

    const user = await resolveSession(app.deps.pool, app.deps.clock, token);
    // A session is bound to its Client: a token minted on one subdomain must not
    // authenticate on another, even though the token itself is valid.
    if (!user || user.clientId !== client.id) {
      return reply.code(401).send({ error: "unauthorized" });
    }

    return reply.code(200).send({
      user: { id: user.id, email: user.email },
      client: { id: client.id, subdomain: client.subdomain, timezone: client.timezone },
    });
  });
}
