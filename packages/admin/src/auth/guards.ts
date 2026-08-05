import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { resolveAdminSession, type Superadmin } from "./superadmins.js";
import { sessionToken } from "./session-cookie.js";

/**
 * The one gate every administrative route goes through.
 *
 * There is no tenant to resolve here — a Superadmin belongs to no Client and
 * operates across all of them — so authentication is the whole of it: a live,
 * unexpired session cookie belonging to an account that still exists. Later
 * slices hang every Client-mutating route off this, so none of them can forget.
 */
export async function authenticateAdminRequest(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<Superadmin | null> {
  const token = sessionToken(request);
  if (!token) {
    await reply.code(401).send({ error: "unauthorized" });
    return null;
  }

  const app = request.server;
  const superadmin = await resolveAdminSession(app.adminDeps.pool, app.adminDeps.clock, token);
  if (!superadmin) {
    await reply.code(401).send({ error: "unauthorized" });
    return null;
  }

  return superadmin;
}

/**
 * Put every route in a plugin behind {@link authenticateAdminRequest}, asked
 * once.
 *
 * Fastify encapsulates a plugin's hooks, so this covers exactly the routes
 * registered in that plugin — and, unlike a check inside each handler, it covers
 * the ones a later slice adds without anyone having to remember. One line per
 * administrative route file is the whole of what has to be remembered.
 */
export function requireAdminSession(app: FastifyInstance): void {
  app.addHook("preHandler", async (request, reply) => {
    // Returning the reply is how an async hook halts the lifecycle; the 401 has
    // already been sent by then.
    if (!(await authenticateAdminRequest(request, reply))) return reply;
  });
}
