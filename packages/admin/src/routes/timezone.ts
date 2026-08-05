import type { FastifyInstance } from "fastify";
import { updateTimezone } from "@smma/core";
import { requireAdminSession } from "../auth/guards.js";
import { answeringProvisionErrors } from "./provision-errors.js";
import { requireClient } from "./require-client.js";
import { previewTimezoneShift } from "../timezone-shift.js";

/**
 * The clock a Client's scheduling and analytics are anchored to, and the preview
 * that has to come before changing it (PRD #15 stories 51–52).
 *
 * A timezone is editable where a subdomain is not, and the asymmetry is the
 * whole design. A wrong timezone is invisible until someone reads a time, and
 * re-creating the Client to fix a typo would cost it every Post and Connected
 * Account it has. A wrong subdomain is fixed by provisioning again, because
 * renaming one breaks every link that already points at it — so there is no
 * route here that takes one, and the Client screen shows it read-only.
 *
 * The preview is a separate GET, and that separation is what makes cancelling
 * real: reading what the change would look like cannot have committed it, so an
 * operator who backs out has provably changed nothing.
 */

export async function registerTimezoneRoutes(app: FastifyInstance): Promise<void> {
  requireAdminSession(app);

  /**
   * What the change will look like to this Client's Users: every Scheduled
   * Post's displayed time, as it reads now and as it would read after.
   *
   * The proposed zone is a query parameter because this is a read of a
   * hypothetical — the operator is asking about a Client that has not changed,
   * and nothing about the request should suggest otherwise.
   */
  app.get<{ Params: { clientId: string }; Querystring: { timezone?: string } }>(
    "/api/clients/:clientId/timezone-shift",
    async (request, reply) => {
      const { timezone } = request.query;
      if (typeof timezone !== "string" || timezone.trim() === "") {
        // `invalid_body` even though the fault is in the querystring: the panel
        // has one code for "this panel sent a malformed request", and a second
        // one meaning the same thing about a different part of the request would
        // be a distinction only the server cares about.
        return reply
          .code(400)
          .send({ error: "invalid_body", message: "A timezone to preview is required." });
      }

      return answeringProvisionErrors(reply, async () => {
        // Read explicitly: a Client that does not exist is not a Client with
        // nothing scheduled, and an empty preview would read exactly like one.
        const client = await requireClient(app.adminDeps.pool, request.params.clientId);
        return reply
          .code(200)
          .send({ shift: await previewTimezoneShift(app.adminDeps.pool, client, timezone) });
      });
    },
  );

  /**
   * Re-anchor the Client.
   *
   * Nothing here consults the preview, on purpose and for the same reason the
   * Plan route does not consult its counts: the preview exists so the operator
   * is not surprised, and making the mutation depend on one would turn a
   * courtesy into a load-bearing part of the write path.
   *
   * It moves no Posts, and could not — their instants are stored in UTC and this
   * touches only the Client's anchor. What changes is what those instants read
   * as, which is exactly what the preview showed.
   */
  app.patch<{ Params: { clientId: string }; Body: { timezone?: string } }>(
    "/api/clients/:clientId/timezone",
    async (request, reply) => {
      const { timezone } = request.body ?? {};
      if (typeof timezone !== "string") {
        return reply
          .code(400)
          .send({ error: "invalid_body", message: "timezone is required." });
      }

      return answeringProvisionErrors(reply, async () => {
        const client = await updateTimezone(
          app.adminDeps.pool,
          request.params.clientId,
          timezone,
        );
        return reply.code(200).send({ client });
      });
    },
  );
}
