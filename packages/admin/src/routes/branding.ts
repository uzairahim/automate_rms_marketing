import type { FastifyInstance } from "fastify";
import {
  ProvisionError,
  getBranding,
  normalizeAppName,
  normalizeLogoUrl,
  normalizePrimaryColor,
  updateBranding,
  type BrandingPatch,
} from "@smma/core";
import { requireAdminSession } from "../auth/guards.js";
import { answeringProvisionErrors } from "./provision-errors.js";

/**
 * A Client's white-label look: its logo, its primary color, and the name the app
 * calls itself on that Client's subdomain (PRD #15 stories 46–50).
 *
 * What makes these two routes worth care is where their output ends up. The
 * Client SPA resolves Branding from the subdomain and applies it at load —
 * *before* anyone authenticates — so a value accepted here is rendered on a
 * login screen to people who have no idea an operator exists and nobody to ask
 * about it. Hence the read: an operator edits from what is live rather than from
 * memory. And hence the refusals: `@smma/core` decides what a usable color, URL,
 * and name are, and anything else is turned down at the door rather than stored
 * and shipped to a Client's front page.
 */

/**
 * Read a {@link BrandingPatch} off the wire. Each field is tri-state, and the
 * three states are what let a change be undone without inventing a replacement
 * value:
 *
 *   - absent — leave the stored value alone;
 *   - `null` — reset to the neutral default (or clear the logo outright);
 *   - a string — set it, normalized and validated by `@smma/core`.
 *
 * `in` rather than a truthiness check, because `null` is the meaningful state
 * that a looser test would silently drop — the reset would appear to succeed and
 * change nothing.
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
    else {
      throw new ProvisionError(
        "invalid_primary_color",
        "primaryColor must be a string or null.",
      );
    }
  }
  if ("logoUrl" in body) {
    const value = body.logoUrl;
    if (value === null) patch.logoUrl = null;
    else if (typeof value === "string") patch.logoUrl = normalizeLogoUrl(value);
    else throw new ProvisionError("invalid_logo_url", "logoUrl must be a string or null.");
  }

  return patch;
}

export async function registerBrandingRoutes(app: FastifyInstance): Promise<void> {
  requireAdminSession(app);

  // What this Client looks like as it stands. The form is filled from this, so
  // the operator is editing the live values rather than retyping from memory —
  // and a field they leave alone is one they have actually seen.
  //
  // No `requireClient` first, unlike the other reads on this panel: those would
  // otherwise answer an empty list where a Client does not exist, which reads
  // exactly like one that does. `getBranding` has no such ambiguity — it raises
  // `client_not_found` itself rather than resolving a missing row to defaults.
  app.get<{ Params: { clientId: string } }>(
    "/api/clients/:clientId/branding",
    async (request, reply) => {
      return answeringProvisionErrors(reply, async () => {
        const branding = await getBranding(app.adminDeps.pool, request.params.clientId);
        return reply.code(200).send({ branding });
      });
    },
  );

  /**
   * Change it. A patch, so the panel can clear a logo without restating a name
   * and color it did not touch.
   *
   * No `requireClient` first, for the reason the Plan route gives: this has a
   * write to fail, and `updateBranding` already reports a Client that matched no
   * row as `client_not_found`. One round trip, and no window in which the Client
   * could vanish between the check and the write.
   */
  app.patch<{ Params: { clientId: string }; Body: Record<string, unknown> }>(
    "/api/clients/:clientId/branding",
    async (request, reply) => {
      return answeringProvisionErrors(reply, async () => {
        const patch = parseBrandingPatch(request.body ?? {});

        // A patch naming nothing is refused rather than answered with the
        // unchanged Branding: the only way to send one is a misspelled field,
        // and reporting success for a change that did not happen would send the
        // operator away believing a Client's login screen now says something it
        // does not.
        if (Object.keys(patch).length === 0) {
          return reply.code(400).send({
            error: "invalid_body",
            message: "Name at least one of: appName, primaryColor, logoUrl.",
          });
        }

        const branding = await updateBranding(app.adminDeps.pool, request.params.clientId, patch);
        return reply.code(200).send({ branding });
      });
    },
  );
}
