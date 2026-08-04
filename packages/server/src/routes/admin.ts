import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  createClient,
  createUser,
  isAccessStatus,
  listClients,
  normalizeAppName,
  normalizeLogoUrl,
  normalizePrimaryColor,
  ProvisionError,
  resolveSurface,
  setUserPassword,
  updateBranding,
  updatePlan,
  type BrandingPatch,
  type PlanPatch,
  type ProvisionErrorCode,
} from "@smma/core";

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
  invalid_plan: 400,
  invalid_access_status: 400,
  invalid_app_name: 400,
  invalid_primary_color: 400,
  invalid_logo_url: 400,
  subdomain_taken: 409,
  email_taken: 409,
  client_not_found: 404,
  user_not_found: 404,
};

/**
 * Parse a plan-patch request body into a typed {@link PlanPatch}, rejecting any
 * malformed field. Only the fields present in the body are set; a bad platform
 * toggle or unknown access status is a 400 via {@link ProvisionError}.
 */
function parsePlanPatch(body: Record<string, unknown>): PlanPatch {
  const patch: PlanPatch = {};
  for (const platform of ["facebook", "instagram", "tiktok"] as const) {
    const value = body[platform];
    if (value === undefined) continue;
    if (typeof value !== "boolean") {
      throw new ProvisionError("invalid_plan", `${platform} must be a boolean.`);
    }
    patch[platform] = value;
  }
  if (body.accessStatus !== undefined) {
    const status = body.accessStatus;
    if (typeof status !== "string" || !isAccessStatus(status)) {
      throw new ProvisionError(
        "invalid_access_status",
        "accessStatus must be one of: active, suspended, expired.",
      );
    }
    patch.accessStatus = status;
  }
  return patch;
}

/**
 * Parse a branding-patch request body into a typed {@link BrandingPatch}. Each
 * field is tri-state: absent leaves the stored value untouched, an explicit
 * `null` resets it to the neutral default (or clears the logo), and a string is
 * validated and normalized. A malformed value is a 400 via {@link ProvisionError}.
 */
function parseBrandingPatch(body: Record<string, unknown>): BrandingPatch {
  const patch: BrandingPatch = {};

  if ("appName" in body) {
    const value = body.appName;
    if (value === null) patch.appName = null;
    else if (typeof value === "string") patch.appName = normalizeAppName(value);
    else throw new ProvisionError("invalid_app_name", "appName must be a string or null.");
  }
  if ("primaryColor" in body) {
    const value = body.primaryColor;
    if (value === null) patch.primaryColor = null;
    else if (typeof value === "string") patch.primaryColor = normalizePrimaryColor(value);
    else throw new ProvisionError("invalid_primary_color", "primaryColor must be a string or null.");
  }
  if ("logoUrl" in body) {
    const value = body.logoUrl;
    if (value === null) patch.logoUrl = null;
    else if (typeof value === "string") patch.logoUrl = normalizeLogoUrl(value);
    else throw new ProvisionError("invalid_logo_url", "logoUrl must be a string or null.");
  }

  return patch;
}

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

  app.post<{
    Body: { subdomain?: string; timezone?: string; plan?: Record<string, unknown> };
  }>("/api/admin/clients", { preHandler: guard }, async (request, reply) => {
    const { subdomain, timezone, plan } = request.body ?? {};
    if (typeof subdomain !== "string" || typeof timezone !== "string") {
      return reply
        .code(400)
        .send({ error: "invalid_body", message: "subdomain and timezone are required." });
    }
    try {
      // Only the platform toggles may be set at creation; access status is always
      // `active` for a new Client, so ignore any accessStatus in the create body.
      const { accessStatus: _ignored, ...toggles } = plan ? parsePlanPatch(plan) : {};
      const client = await createClient(app.deps.pool, { subdomain, timezone, plan: toggles });
      return reply.code(201).send(client);
    } catch (err) {
      if (err instanceof ProvisionError) return sendProvisionError(reply, err);
      throw err;
    }
  });

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

  // Change a Client's Plan after creation (PRD stories 8, 13): toggle platforms
  // and/or set access status. Any subset of fields may be sent; the rest are
  // left as-is. This is the Superadmin's single lever over Client access.
  app.patch<{ Params: { clientId: string }; Body: Record<string, unknown> }>(
    "/api/admin/clients/:clientId/plan",
    { preHandler: guard },
    async (request, reply) => {
      let patch;
      try {
        patch = parsePlanPatch(request.body ?? {});
      } catch (err) {
        if (err instanceof ProvisionError) return sendProvisionError(reply, err);
        throw err;
      }
      try {
        const plan = await updatePlan(app.deps.pool, request.params.clientId, patch);
        return reply.code(200).send({ id: request.params.clientId, plan });
      } catch (err) {
        if (err instanceof ProvisionError) return sendProvisionError(reply, err);
        throw err;
      }
    },
  );

  // Set a Client's white-label branding (PRD story 5): logo, primary color, and
  // app display name. Any subset of fields may be sent; an explicit null resets
  // that field to the neutral default. The Client SPA fetches the resolved
  // branding from its subdomain at load (GET /api/branding).
  app.patch<{ Params: { clientId: string }; Body: Record<string, unknown> }>(
    "/api/admin/clients/:clientId/branding",
    { preHandler: guard },
    async (request, reply) => {
      let patch: BrandingPatch;
      try {
        patch = parseBrandingPatch(request.body ?? {});
      } catch (err) {
        if (err instanceof ProvisionError) return sendProvisionError(reply, err);
        throw err;
      }
      try {
        const branding = await updateBranding(app.deps.pool, request.params.clientId, patch);
        return reply.code(200).send({ id: request.params.clientId, branding });
      } catch (err) {
        if (err instanceof ProvisionError) return sendProvisionError(reply, err);
        throw err;
      }
    },
  );

  // Set any User's password directly — the Superadmin's out-of-band unblock for
  // a User who can't complete the self-service reset. Revokes the User's live
  // sessions and pending reset links so the new password takes effect at once.
  app.post<{ Params: { userId: string }; Body: { password?: string } }>(
    "/api/admin/users/:userId/password",
    { preHandler: guard },
    async (request, reply) => {
      const { password } = request.body ?? {};
      if (typeof password !== "string") {
        return reply
          .code(400)
          .send({ error: "invalid_body", message: "password is required." });
      }
      try {
        await setUserPassword(app.deps.pool, { userId: request.params.userId, password });
        return reply.code(200).send({ status: "ok" });
      } catch (err) {
        if (err instanceof ProvisionError) return sendProvisionError(reply, err);
        throw err;
      }
    },
  );
}
