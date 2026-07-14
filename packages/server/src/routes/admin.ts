import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { resolveSurface } from "../tenancy/subdomain.js";
import {
  createClient,
  createUser,
  listClients,
  ProvisionError,
  type ProvisionErrorCode,
} from "../tenancy/clients.js";

/**
 * The Superadmin `admin.` API surface (PRD stories 1, 5, 7, 12).
 *
 * These routes provision Clients and their Users and list every Client. They
 * are deliberately *not* tenant-scoped: the Superadmin operates across all
 * Clients via an explicit Client id in the path, never by "which subdomain am
 * I on." Access requires (a) the request to be on the `admin.` surface and
 * (b) the shared Superadmin token — a Client subdomain can never reach them.
 */

const HTTP_STATUS: Record<ProvisionErrorCode, number> = {
  invalid_subdomain: 400,
  invalid_timezone: 400,
  invalid_email: 400,
  weak_password: 400,
  subdomain_taken: 409,
  email_taken: 409,
  client_not_found: 404,
};

function sendProvisionError(reply: FastifyReply, err: ProvisionError): FastifyReply {
  return reply.code(HTTP_STATUS[err.code]).send({ error: err.code, message: err.message });
}

/** Constant-time comparison of the presented bearer token to the configured secret. */
function tokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function registerSuperadminRoutes(app: FastifyInstance): Promise<void> {
  // Gate every admin route: correct surface, then correct token. A wrong
  // surface is a 404 (the admin API does not exist on a Client subdomain);
  // a missing/bad token on the admin surface is a 401.
  const guard = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const surface = resolveSurface(request.headers.host, app.deps.baseDomain);
    if (surface.kind !== "admin") {
      await reply.code(404).send({ error: "not_found" });
      return;
    }
    const header = request.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    if (!token || !tokenMatches(token, app.deps.superadminToken)) {
      await reply.code(401).send({ error: "unauthorized" });
      return;
    }
  };

  app.post<{ Body: { subdomain?: string; timezone?: string } }>(
    "/api/admin/clients",
    { preHandler: guard },
    async (request, reply) => {
      const { subdomain, timezone } = request.body ?? {};
      if (typeof subdomain !== "string" || typeof timezone !== "string") {
        return reply
          .code(400)
          .send({ error: "invalid_body", message: "subdomain and timezone are required." });
      }
      try {
        const client = await createClient(app.deps.pool, { subdomain, timezone });
        return reply.code(201).send(client);
      } catch (err) {
        if (err instanceof ProvisionError) return sendProvisionError(reply, err);
        throw err;
      }
    },
  );

  app.get("/api/admin/clients", { preHandler: guard }, async () => {
    return listClients(app.deps.pool);
  });

  app.post<{ Params: { clientId: string }; Body: { email?: string; password?: string } }>(
    "/api/admin/clients/:clientId/users",
    { preHandler: guard },
    async (request, reply) => {
      const { email, password } = request.body ?? {};
      if (typeof email !== "string" || typeof password !== "string") {
        return reply
          .code(400)
          .send({ error: "invalid_body", message: "email and password are required." });
      }
      try {
        const user = await createUser(app.deps.pool, {
          clientId: request.params.clientId,
          email,
          password,
        });
        return reply.code(201).send(user);
      } catch (err) {
        if (err instanceof ProvisionError) return sendProvisionError(reply, err);
        throw err;
      }
    },
  );
}
