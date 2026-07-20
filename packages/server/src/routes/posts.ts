import type { FastifyInstance } from "fastify";
import { authenticateClientRequest } from "../auth/guards.js";
import { isPlatform, planEnables } from "../tenancy/plan.js";
import type { Platform } from "../core/publisher.js";
import { findAccount } from "../connections/accounts.js";
import { validateContent, type ComposedMedia } from "../posts/validation.js";
import { createPost, findPost, listTargets, type Post, type Target } from "../posts/posts.js";
import { publishPost, manualRetryTarget } from "../posts/publish.js";

/**
 * Composing and publishing a Post (PRD stories 29–34, 39–43; Slice 8).
 *
 * Scheduling and drafts arrive in Slice 10 — today a Post either fails
 * validate-and-gate and is never created, or is created and published
 * immediately, fanning out to one Target per selected platform.
 */

interface ComposeBody {
  text?: unknown;
  media?: { url?: unknown; type?: unknown };
  platforms?: unknown;
}

/** What the compose body names as media, or an error if it is malformed. */
function parseMedia(body: ComposeBody): { media: ComposedMedia | null } | { error: string } {
  if (body.media === undefined) return { media: null };
  const { url, type } = body.media;
  if (typeof url !== "string" || !url || (type !== "image" && type !== "video")) {
    return { error: "media must have a url and a type of \"image\" or \"video\"." };
  }
  return { media: { url, type } };
}

export async function registerPostRoutes(app: FastifyInstance): Promise<void> {
  // Compose and publish immediately (PRD story 34). Scheduling/drafts are a
  // later slice, so today this is the only way a Post is created.
  app.post<{ Body: ComposeBody }>("/api/posts", async (request, reply) => {
    const ctx = await authenticateClientRequest(request, reply);
    if (!ctx) return reply;

    const body = request.body ?? {};
    const text = typeof body.text === "string" ? body.text : "";

    const parsedMedia = parseMedia(body);
    if ("error" in parsedMedia) {
      return reply.code(400).send({ error: "invalid_media", message: parsedMedia.error });
    }

    const rawPlatforms = Array.isArray(body.platforms) ? body.platforms : [];
    if (rawPlatforms.length === 0) {
      return reply.code(400).send({
        error: "no_platforms_selected",
        message: "Select at least one platform to publish to.",
      });
    }
    const unknown = rawPlatforms.find((p) => typeof p !== "string" || !isPlatform(p));
    if (unknown !== undefined) {
      return reply.code(400).send({
        error: "unknown_platform",
        message: `${String(unknown)} isn't a platform this app publishes to.`,
      });
    }
    const platforms = rawPlatforms as Platform[];

    // Plan gating: a Client may only target platforms its Plan enables (PRD
    // story 27), same gate the connect flow applies.
    const notEnabled = platforms.find((platform) => !planEnables(ctx.client.plan, platform));
    if (notEnabled) {
      return reply.code(403).send({
        error: "platform_not_enabled",
        message: `This Client's plan does not include ${notEnabled}.`,
      });
    }

    // A Target needs a live destination to publish to — selecting a platform
    // with nothing connected has nowhere to fan out to.
    const { pool, clock, publisher } = app.deps;
    for (const platform of platforms) {
      const account = await findAccount(pool, ctx.client.id, platform);
      if (account?.status !== "connected") {
        return reply.code(409).send({
          error: "platform_not_connected",
          message: `Connect ${platform} before publishing to it.`,
        });
      }
    }

    // Validate-and-gate: the content must satisfy every selected platform's
    // rules before anything is created (PRD stories 32–33).
    const validation = validateContent({ text, media: parsedMedia.media ?? undefined }, platforms);
    if (!validation.valid) {
      return reply.code(422).send({
        error: "invalid_content",
        message: "This content doesn't satisfy every selected platform's requirements.",
        reasons: validation.reasons,
      });
    }

    const { post, targets } = await createPost(pool, clock, {
      clientId: ctx.client.id,
      authorId: ctx.user.id,
      text,
      media: parsedMedia.media,
      platforms,
    });
    const publishedTargets = await publishPost(pool, clock, publisher, post, targets);
    const final = await findPost(pool, ctx.client.id, post.id);

    return reply
      .code(201)
      .send({ post: postView(final ?? post), targets: publishedTargets.map(targetView) });
  });

  // A Post's current state — used to watch a Publishing Post settle, and to
  // read which Target(s) failed (PRD story 43).
  app.get<{ Params: { id: string } }>("/api/posts/:id", async (request, reply) => {
    const ctx = await authenticateClientRequest(request, reply);
    if (!ctx) return reply;

    const { pool } = app.deps;
    const post = await findPost(pool, ctx.client.id, request.params.id);
    if (!post) {
      return reply.code(404).send({ error: "post_not_found" });
    }
    const targets = await listTargets(pool, post.id);
    return reply.code(200).send({ post: postView(post), targets: targets.map(targetView) });
  });

  // A User's manual retry of one failed Target (PRD story 43). Only meaningful
  // once the automatic 2x-retry chain has already given up.
  app.post<{ Params: { id: string; platform: string } }>(
    "/api/posts/:id/targets/:platform/retry",
    async (request, reply) => {
      const ctx = await authenticateClientRequest(request, reply);
      if (!ctx) return reply;

      const { platform } = request.params;
      if (!isPlatform(platform)) {
        return reply.code(404).send({ error: "unknown_platform" });
      }

      const { pool, clock, publisher } = app.deps;
      const post = await findPost(pool, ctx.client.id, request.params.id);
      if (!post) {
        return reply.code(404).send({ error: "post_not_found" });
      }

      const result = await manualRetryTarget(pool, clock, publisher, post, platform);
      if (!result) {
        return reply.code(409).send({
          error: "target_not_failed",
          message: "Only a failed Target can be retried.",
        });
      }

      const final = await findPost(pool, ctx.client.id, post.id);
      return reply
        .code(200)
        .send({ post: postView(final ?? post), targets: result.targets.map(targetView) });
    },
  );
}

function postView(post: Post) {
  return {
    id: post.id,
    text: post.text,
    media: post.media,
    status: post.status,
    createdAt: post.createdAt,
    updatedAt: post.updatedAt,
  };
}

function targetView(target: Target) {
  return {
    platform: target.platform,
    status: target.status,
    externalId: target.externalId,
    permalink: target.permalink,
    error: target.error,
    retryCount: target.retryCount,
  };
}
