import type { FastifyInstance } from "fastify";
import { resolveClientForRequest } from "../auth/guards.js";
import { getBranding } from "@smma/core";

/**
 * Client-facing branding surface (PRD story 5). The SPA fetches this at load,
 * before anyone logs in, so it can render the Client's logo, primary color, and
 * app name — including on the login screen — and never show operator identity.
 *
 * Branding is resolved purely from the request subdomain and is deliberately
 * *public*: it carries no secrets and gates nothing, so requiring a session
 * would defeat the point (an unauthenticated login screen must still be
 * branded). It is not gated on access status either — a suspended Client's
 * login screen is still its own. An unknown subdomain is a 404.
 */
export async function registerBrandingRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/branding", async (request, reply) => {
    // resolveClientForRequest scopes strictly to the request's own subdomain and
    // 404s an unknown/foreign host, so the payload is always the correct Client's.
    const client = await resolveClientForRequest(request, reply);
    if (!client) return reply;

    const branding = await getBranding(app.deps.pool, client.id);
    // No caching: "changing branding is reflected on next load" (PRD story 5)
    // must hold in a real browser/CDN, not just server-side — a stale cached
    // payload would show a Client its old logo/color after the Superadmin edits.
    return reply.code(200).header("cache-control", "no-store").send({ branding });
  });
}
