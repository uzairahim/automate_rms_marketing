import type { FastifyReply, FastifyRequest } from "fastify";
import { resolveSurface } from "../tenancy/subdomain.js";
import { findClientBySubdomain, type Client } from "../tenancy/clients.js";
import type { AccessStatus } from "../tenancy/plan.js";
import { resolveSession, type SessionUser } from "./sessions.js";

/**
 * Request guards shared by every Client-facing route.
 *
 * The tenant is always resolved from the request subdomain, and two gates
 * (Slice 3) are enforced in one place so no route can forget them:
 *   - the session must belong to the subdomain's Client, and
 *   - the Client's Plan access status must be `active`.
 *
 * A suspended/expired Client blocks every action even with a live session — so
 * this is the single choke point future action routes authenticate through.
 */

/** The error code a non-active access status surfaces to a blocked User. */
const ACCESS_DENIED: Record<Exclude<AccessStatus, "active">, string> = {
  suspended: "client_suspended",
  expired: "client_expired",
};

/**
 * The blocking error for a Client's access status, or null if it may act.
 * Exposed so the login route can apply the same gate before opening a session.
 */
export function accessDenied(
  status: AccessStatus,
): { error: string; message: string } | null {
  if (status === "active") return null;
  return {
    error: ACCESS_DENIED[status],
    message:
      status === "suspended"
        ? "Access has been suspended. Please contact your administrator."
        : "Access has expired. Please contact your administrator.",
  };
}

/** The bearer token presented on the request, or "" if none. */
export function bearerToken(request: FastifyRequest): string {
  const header = request.headers.authorization ?? "";
  return header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
}

/**
 * Resolve the Client for the request subdomain, or reply 404 and return null.
 * Does not check access status — login must resolve the Client to then report a
 * suspended/expired reason.
 */
export async function resolveClientForRequest(
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

/**
 * Fully authenticate a Client-facing request: resolve the tenant, the session,
 * and the access-status gate. On any failure this replies (404 unknown client,
 * 401 missing/foreign session, 403 suspended/expired) and returns null; the
 * caller returns `reply` untouched. On success it returns the Client and User.
 */
export async function authenticateClientRequest(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<{ client: Client; user: SessionUser } | null> {
  const client = await resolveClientForRequest(request, reply);
  if (!client) return null;

  const token = bearerToken(request);
  if (!token) {
    await reply.code(401).send({ error: "unauthorized" });
    return null;
  }

  const app = request.server;
  const user = await resolveSession(app.deps.pool, app.deps.clock, token);
  // A session is bound to its Client: a token minted on one subdomain must not
  // authenticate on another, even though the token itself is valid.
  if (!user || user.clientId !== client.id) {
    await reply.code(401).send({ error: "unauthorized" });
    return null;
  }

  // Access status gates a live session too: a Client suspended after login can
  // no longer act, and the User sees the same clear reason as at the login gate.
  const denied = accessDenied(client.plan.accessStatus);
  if (denied) {
    await reply.code(403).send(denied);
    return null;
  }

  return { client, user };
}
