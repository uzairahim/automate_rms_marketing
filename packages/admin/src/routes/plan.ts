import type { FastifyInstance } from "fastify";
import { PLATFORMS, updatePlan } from "@smma/core";
import { requireAdminSession } from "../auth/guards.js";
import { answeringProvisionErrors } from "./provision-errors.js";
import { parsePlanPatch } from "./plan-body.js";
import { requireClient } from "./require-client.js";
import { countScheduledPosts } from "../scheduled-posts.js";

/**
 * The operator's two levers on a Client: which platforms it may use, and whether
 * it may act at all — plus the read that makes their consequences visible before
 * either is committed (PRD #15 stories 35–40).
 *
 * Both levers are one PATCH because they are one Plan (CONTEXT.md `Plan`), and
 * `@smma/core` already applies them as one patch. The panel presents them as two
 * separate controls with two different confirmations, but that is a question of
 * what an operator is deciding, not of what a Plan is.
 *
 * The preview is a separate GET, and that separation is what makes cancelling
 * real: looking at the cost of a change is a read that cannot have committed it,
 * so an operator who backs out of the confirmation has provably changed nothing.
 */

export async function registerPlanRoutes(app: FastifyInstance): Promise<void> {
  requireAdminSession(app);

  /**
   * Change a Client's Plan. A patch: only the fields sent change, so the panel
   * can flip one platform without restating the other two and without racing a
   * change made from another tab.
   *
   * Nothing here consults the consequence preview, on purpose. The previews
   * exist so an operator is not surprised; making the mutation depend on one
   * would make the safety of a downgrade rest on a courtesy, when it rests on
   * the fire-time eligibility check in ADR 0011.
   *
   * Alone among these routes it does not call `requireClient` first, for the
   * same reason `POST .../users` does not: it has a write to fail, and
   * `updatePlan` already reports a Client that matched no row as the same
   * `client_not_found`. One round trip rather than two, and it cannot race a
   * Client that disappeared in between.
   */
  app.patch<{ Params: { clientId: string }; Body: Record<string, unknown> }>(
    "/api/clients/:clientId/plan",
    async (request, reply) => {
      return answeringProvisionErrors(reply, async () => {
        const patch = parsePlanPatch(request.body ?? {});

        // A patch that names nothing is refused rather than answered with an
        // unchanged Plan: the only way to send one is a misspelled field, and
        // reporting success for a change that did not happen is the worst
        // possible answer on the route that suspends Clients.
        if (Object.keys(patch).length === 0) {
          return reply.code(400).send({
            error: "invalid_body",
            message: `Name at least one of: ${PLATFORMS.join(", ")}, accessStatus.`,
          });
        }

        const plan = await updatePlan(app.adminDeps.pool, request.params.clientId, patch);
        return reply.code(200).send({ plan });
      });
    },
  );

  /**
   * What a change to this Client is about to break — the counts behind both
   * confirmations, answered together because the operator's next action is one
   * of the two and the panel should not have to guess which.
   */
  app.get<{ Params: { clientId: string } }>(
    "/api/clients/:clientId/scheduled-post-counts",
    async (request, reply) => {
      return answeringProvisionErrors(reply, async () => {
        const { clientId } = request.params;
        await requireClient(app.adminDeps.pool, clientId);
        return reply
          .code(200)
          .send({ counts: await countScheduledPosts(app.adminDeps.pool, clientId) });
      });
    },
  );
}
