import type { FastifyInstance } from "fastify";
import { authenticateClientRequest } from "../auth/guards.js";
import { enabledPlatforms, isPlatform, planEnables } from "@smma/core";

/**
 * Plan-scoped platform surface (PRD story 27). A User only ever sees and acts on
 * the platforms their Client's Plan enables.
 *
 * `GET /api/platforms` lists the enabled platforms the SPA may render. The
 * per-platform route is the reusable plan gate: a platform the Plan does not
 * enable is a 403 `platform_not_enabled`, never reachable. Later slices (connect,
 * compose) hang their real per-platform routes off this same check, so a
 * disabled platform can never be acted on.
 */
export async function registerPlatformRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/platforms", async (request, reply) => {
    const ctx = await authenticateClientRequest(request, reply);
    if (!ctx) return reply;
    return reply.code(200).send({ platforms: enabledPlatforms(ctx.client.plan) });
  });

  app.get<{ Params: { platform: string } }>(
    "/api/platforms/:platform",
    async (request, reply) => {
      const ctx = await authenticateClientRequest(request, reply);
      if (!ctx) return reply;

      const { platform } = request.params;
      if (!isPlatform(platform)) {
        return reply.code(404).send({ error: "unknown_platform" });
      }
      if (!planEnables(ctx.client.plan, platform)) {
        return reply.code(403).send({
          error: "platform_not_enabled",
          message: `This Client's plan does not include ${platform}.`,
        });
      }
      return reply.code(200).send({ platform, enabled: true });
    },
  );
}
