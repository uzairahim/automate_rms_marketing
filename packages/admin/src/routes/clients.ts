import type { FastifyInstance } from "fastify";
import { createClient, listClients } from "@smma/core";
import { requireAdminSession } from "../auth/guards.js";
import { answeringProvisionErrors } from "./provision-errors.js";
import { parsePlanToggles } from "./plan-body.js";
import { requireClient } from "./require-client.js";

/**
 * The Superadmin's single global view of the platform, and the ability to add
 * to it.
 *
 * These routes are deliberately not tenant-scoped — there is no subdomain to
 * resolve here, and a Client is named by an explicit id in the path — which is
 * exactly why every one of them is behind {@link requireAdminSession}: the only
 * thing standing between a caller and every Client on the platform is a live
 * operator session.
 */

export async function registerClientRoutes(app: FastifyInstance): Promise<void> {
  requireAdminSession(app);

  // Provision a Client. An omitted platform toggle is off here — a Client sees
  // and pays for only what it needs — where the same field on a patch means
  // unchanged; `parsePlanToggles` reads the wire, and this is what decides what
  // silence in it means.
  //
  // Access status is not read from a create body at all: a new Client is always
  // `active`, so there is nothing here for a caller to set, correctly or
  // otherwise, which is why this parses toggles rather than a whole Plan patch.
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
  // too.
  app.get<{ Params: { clientId: string } }>("/api/clients/:clientId", async (request, reply) => {
    return answeringProvisionErrors(reply, async () => {
      const client = await requireClient(app.adminDeps.pool, request.params.clientId);
      return reply.code(200).send({ client });
    });
  });
}
