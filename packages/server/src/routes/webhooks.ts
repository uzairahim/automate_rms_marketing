import type { FastifyInstance } from "fastify";
import { disconnectByPlatformUser } from "../connections/accounts.js";
import { verifySignedRequest } from "../connections/meta-signed-request.js";

/**
 * Platform callbacks — requests from Meta rather than from a User.
 *
 * These are public and unauthenticated by necessity: Meta has no session with
 * us. What stands in for authentication is the `signed_request` signature, so
 * every route here verifies it before touching anything, and treats an
 * unverifiable request as noise rather than an error worth explaining.
 *
 * A working deauthorization callback is required for Meta App Review, and the
 * PRD is explicit that it belongs in the connect flow rather than being bolted
 * on later — it is the other half of connecting.
 */
export async function registerWebhookRoutes(app: FastifyInstance): Promise<void> {
  // Meta calls this when a person removes our app from their Facebook settings.
  // Their tokens are void from that moment, so the Connected Account must stop
  // claiming to be connected — otherwise the User's first sign of trouble is a
  // Post failing to publish.
  app.post<{ Body: { signed_request?: string } }>(
    "/api/webhooks/meta/deauthorize",
    async (request, reply) => {
      const signedRequest = request.body?.signed_request;
      const appSecret = app.deps.metaAppSecret;
      // With no app secret there is nothing to verify against, so every request
      // is unverifiable — including a genuine one. Refusing is the only safe
      // reading: an empty secret is one an attacker could sign with too.
      if (!appSecret || typeof signedRequest !== "string" || !signedRequest) {
        return reply.code(400).send({ error: "invalid_signed_request" });
      }

      const payload = verifySignedRequest(appSecret, signedRequest);
      if (!payload) {
        return reply.code(400).send({ error: "invalid_signed_request" });
      }

      // Keyed by the authorizing person, because that is all Meta tells us: one
      // person may have connected Pages for more than one Client.
      const disconnected = await disconnectByPlatformUser(app.deps.pool, app.deps.clock, {
        platform: "facebook",
        platformUserId: payload.userId,
      });

      // Always 200 once the request is genuinely Meta's — including when we had
      // nothing to disconnect. Nothing to do is not a failure, and Meta retries
      // anything else.
      return reply.code(200).send({ disconnected });
    },
  );
}
