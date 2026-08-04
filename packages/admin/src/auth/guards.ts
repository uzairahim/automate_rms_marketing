import type { FastifyReply, FastifyRequest } from "fastify";
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
