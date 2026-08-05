import type { FastifyInstance } from "fastify";
import {
  ProvisionError,
  createUser,
  findUser,
  generatePassword,
  listUsers,
  setUserPassword,
} from "@smma/core";
import { requireAdminSession } from "../auth/guards.js";
import { answeringProvisionErrors } from "./provision-errors.js";
import { requireClient } from "./require-client.js";

/**
 * A Client's Users — who can log in, and how they are issued a credential.
 *
 * Every password this panel hands out is generated here rather than typed: the
 * operator supplies an email and nothing else, and what comes back is returned
 * exactly once, never stored in plaintext, and not recoverable from any later
 * read (PRD #15). There is no self-signup on this platform, so this is the
 * credential a Client is provisioned with — and if a person could type one here,
 * a person's idea of a password is what every Client would start from. A User
 * may of course choose their own afterwards, through the Client-facing
 * self-service reset; that path is theirs, and is where the strength rule in
 * `@smma/core` still earns its keep.
 *
 * Every route is nested under a Client, and looks its User up within that Client
 * rather than by bare id, so a User outside the Client on screen is simply not
 * found.
 */
export async function registerUserRoutes(app: FastifyInstance): Promise<void> {
  requireAdminSession(app);

  // Who can log in. The administrative read nothing else on the platform
  // performs — no Client-facing route ever returns a User's identifier — and
  // therefore the thing that makes the reset below reachable from a UI at all.
  app.get<{ Params: { clientId: string } }>(
    "/api/clients/:clientId/users",
    async (request, reply) => {
      return answeringProvisionErrors(reply, async () => {
        const { clientId } = request.params;
        await requireClient(app.adminDeps.pool, clientId);
        return reply.code(200).send({ users: await listUsers(app.adminDeps.pool, clientId) });
      });
    },
  );

  // Hand a Client a login. The body carries an email and only an email: a
  // `password` sent here is ignored rather than honored, because the whole point
  // is that no operator chooses one.
  //
  // Alone among these routes it does not call `requireClient` first. It has an
  // insert to fail, and letting the foreign key be what says "no such Client"
  // is one round trip rather than two and cannot race a Client removed in
  // between — `createUser` maps that violation to the same `client_not_found`.
  app.post<{ Params: { clientId: string }; Body: { email?: string } }>(
    "/api/clients/:clientId/users",
    async (request, reply) => {
      const { email } = request.body ?? {};
      if (typeof email !== "string") {
        return reply.code(400).send({ error: "invalid_body", message: "email is required." });
      }

      return answeringProvisionErrors(reply, async () => {
        const password = generatePassword();
        const user = await createUser(app.adminDeps.pool, {
          clientId: request.params.clientId,
          email,
          password,
        });
        // The only response that will ever carry it. The operator conveys it out
        // of band; nothing here can show it to them a second time.
        return reply.code(201).send({ user, password });
      });
    },
  );

  // Unblock a locked-out User. Generated and shown once, exactly as at creation
  // — and `setUserPassword` ends their live sessions and any pending
  // self-service reset links, so the old password stops working immediately
  // everywhere rather than lingering until a token expires.
  app.post<{ Params: { clientId: string; userId: string } }>(
    "/api/clients/:clientId/users/:userId/password",
    async (request, reply) => {
      return answeringProvisionErrors(reply, async () => {
        const { clientId, userId } = request.params;
        await requireClient(app.adminDeps.pool, clientId);

        // Scoped to this Client: a User belonging to another one is not this
        // screen's to reset, however the operator arrived at the id.
        const user = await findUser(app.adminDeps.pool, { clientId, userId });
        if (!user) {
          throw new ProvisionError("user_not_found", `No such User: ${userId}`);
        }

        const password = generatePassword();
        await setUserPassword(app.adminDeps.pool, { userId: user.id, password });
        return reply.code(200).send({ user, password });
      });
    },
  );
}
