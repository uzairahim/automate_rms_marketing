import type { FastifyInstance } from "fastify";
import {
  PLATFORMS,
  ProvisionError,
  createClient,
  findClientById,
  listClients,
  type PlanPatch,
} from "@smma/core";
import { authenticateAdminRequest } from "../auth/guards.js";
import { answeringProvisionErrors } from "./provision-errors.js";

/**
 * The Superadmin's single global view of the platform, and the ability to add
 * to it.
 *
 * These routes are deliberately not tenant-scoped — there is no subdomain to
 * resolve here, and a Client is named by an explicit id in the path — which is
 * exactly why every one of them is behind {@link authenticateAdminRequest}: the
 * only thing standing between a caller and every Client on the platform is a
 * live operator session.
 */

/**
 * Read the platform toggles out of a create body. An omitted toggle is off — a
 * Client sees and pays for only what it needs.
 *
 * Access status is not read at all: a new Client is always `active`, so there is
 * nothing here for a caller to set, correctly or otherwise.
 */
function parsePlanToggles(plan: Record<string, unknown>): PlanPatch {
  const toggles: PlanPatch = {};
  for (const platform of PLATFORMS) {
    const value = plan[platform];
    if (value === undefined) continue;
    if (typeof value !== "boolean") {
      throw new ProvisionError("invalid_plan", `${platform} must be true or false.`);
    }
    toggles[platform] = value;
  }
  return toggles;
}

export async function registerClientRoutes(app: FastifyInstance): Promise<void> {
  // Authentication for every route below, asked once. Fastify encapsulates a
  // plugin's hooks, so this covers exactly the routes registered here — and,
  // unlike a check inside each handler, it covers the ones added by the slices
  // after this without anyone having to remember.
  app.addHook("preHandler", async (request, reply) => {
    // Returning the reply is how an async hook halts the lifecycle; the 401 has
    // already been sent by then.
    if (!(await authenticateAdminRequest(request, reply))) return reply;
  });

  app.post<{
    Body: { subdomain?: string; timezone?: string; plan?: Record<string, unknown> };
  }>("/api/clients", async (request, reply) => {
    const { subdomain, timezone, plan } = request.body ?? {};
    if (typeof subdomain !== "string" || typeof timezone !== "string") {
      return reply
        .code(400)
        .send({ error: "invalid_body", message: "subdomain and timezone are required." });
    }

    return answeringProvisionErrors(reply, async () => {
      const client = await createClient(app.adminDeps.pool, {
        subdomain,
        timezone,
        plan: plan ? parsePlanToggles(plan) : {},
      });
      return reply.code(201).send({ client });
    });
  });

  // The whole platform in one screen. No pagination, search, or filter: the
  // operator scale does not warrant them, and every one of them would be a way
  // for a lapsed Client to be off-screen when the operator looks.
  app.get("/api/clients", async (_request, reply) => {
    return reply.code(200).send({ clients: await listClients(app.adminDeps.pool) });
  });

  // One Client — the screen the operator manages it from, and where provisioning
  // lands them. It carries the Plan because the sections that edit it live here
  // too, from the slices after this one.
  app.get<{ Params: { clientId: string } }>("/api/clients/:clientId", async (request, reply) => {
    return answeringProvisionErrors(reply, async () => {
      const client = await findClientById(app.adminDeps.pool, request.params.clientId);
      // Raised rather than answered here, so "no such Client" has one status and
      // one message across every route that can say it.
      if (!client) {
        throw new ProvisionError("client_not_found", `No such Client: ${request.params.clientId}`);
      }
      return reply.code(200).send({ client });
    });
  });
}
