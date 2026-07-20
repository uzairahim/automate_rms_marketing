import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { authenticateClientRequest } from "../auth/guards.js";
import { isPlatform, planEnables, type Plan } from "../tenancy/plan.js";
import type { Clock } from "../core/clock.js";
import type { Platform } from "../core/publisher.js";
import { findAccount } from "../connections/accounts.js";
import { validateContent, type ComposedMedia } from "../posts/validation.js";
import {
  attachMedia,
  createPost,
  findPost,
  listTargets,
  replaceTargets,
  updatePostContent,
  type Post,
  type PostStatus,
  type Target,
} from "../posts/posts.js";
import { publishPost, manualRetryTarget } from "../posts/publish.js";
import { findMedia, mediaPublicUrl } from "../media/media.js";

/**
 * Composing, scheduling, and publishing a Post (PRD stories 29–45; Slices 8, 10).
 *
 * A compose body resolves to exactly one of three outcomes: `draft` (saved
 * as-is, ungated — a User may leave it incomplete), `scheduled` (gated exactly
 * like an immediate publish, but fanned out later by the scheduler's minute
 * tick), or `publishing` (gated and fanned out to every Target right now).
 * {@link resolveCompose} is the single place that decides which, shared by both
 * creating a Post and editing a Draft/Scheduled one before it fires.
 */

interface ComposeBody {
  text?: unknown;
  media?: { mediaId?: unknown };
  platforms?: unknown;
  scheduledAt?: unknown;
  draft?: unknown;
}

/**
 * Resolve the compose body's `media.mediaId` against an uploaded Media
 * (Slice 9): it must exist, belong to this Client, and still be `active` — a
 * purged or unknown id is rejected rather than composing a Post pointed at a
 * dead URL.
 */
async function resolveMedia(
  pool: pg.Pool,
  mediaBaseUrl: string,
  clientId: string,
  body: ComposeBody,
): Promise<{ media: ComposedMedia | null; mediaId: string | null } | { error: string }> {
  if (body.media === undefined) return { media: null, mediaId: null };
  const mediaId = body.media.mediaId;
  if (typeof mediaId !== "string" || !mediaId) {
    return { error: "media must reference an uploaded mediaId." };
  }
  const row = await findMedia(pool, clientId, mediaId);
  if (!row || row.status !== "active") {
    return { error: "Upload media before composing with it." };
  }
  return { media: { url: mediaPublicUrl(mediaBaseUrl, row.id), type: row.type }, mediaId: row.id };
}

type ComposeResolution =
  | {
      ok: true;
      text: string;
      media: ComposedMedia | null;
      mediaId: string | null;
      platforms: Platform[];
      status: PostStatus;
      scheduledAt: Date | null;
    }
  | { ok: false; code: number; body: Record<string, unknown> };

/**
 * Resolve a compose/edit body into what a Post should become: parses and
 * validates content and platform selection, decides `draft` / `scheduled` /
 * `publishing`, and — for anything other than a Draft — applies the same
 * Plan-gating, connected-platform, and validate-and-gate checks an immediate
 * publish always has (PRD story 32: scheduling is blocked exactly like
 * publishing on invalid content). A Draft is deliberately left ungated so a
 * User can save incomplete work and finish it later.
 */
async function resolveCompose(
  pool: pg.Pool,
  clock: Clock,
  mediaBaseUrl: string,
  clientId: string,
  plan: Plan,
  body: ComposeBody,
): Promise<ComposeResolution> {
  const text = typeof body.text === "string" ? body.text : "";

  const parsedMedia = await resolveMedia(pool, mediaBaseUrl, clientId, body);
  if ("error" in parsedMedia) {
    return { ok: false, code: 400, body: { error: "invalid_media", message: parsedMedia.error } };
  }

  const rawPlatforms = Array.isArray(body.platforms) ? body.platforms : [];
  const unknown = rawPlatforms.find((p) => typeof p !== "string" || !isPlatform(p));
  if (unknown !== undefined) {
    return {
      ok: false,
      code: 400,
      body: {
        error: "unknown_platform",
        message: `${String(unknown)} isn't a platform this app publishes to.`,
      },
    };
  }
  const platforms = rawPlatforms as Platform[];

  const draft = body.draft === true;
  let scheduledAt: Date | null = null;
  if (!draft && body.scheduledAt !== undefined) {
    if (typeof body.scheduledAt !== "string") {
      return {
        ok: false,
        code: 400,
        body: { error: "invalid_scheduled_at", message: "scheduledAt must be an ISO timestamp." },
      };
    }
    const parsed = new Date(body.scheduledAt);
    if (Number.isNaN(parsed.getTime())) {
      return {
        ok: false,
        code: 400,
        body: { error: "invalid_scheduled_at", message: "scheduledAt must be an ISO timestamp." },
      };
    }
    if (parsed.getTime() <= clock.now().getTime()) {
      return {
        ok: false,
        code: 400,
        body: { error: "scheduled_time_in_past", message: "scheduledAt must be in the future." },
      };
    }
    scheduledAt = parsed;
  }

  const status: PostStatus = draft ? "draft" : scheduledAt ? "scheduled" : "publishing";

  // A Draft carries no obligation to be complete — gating only applies once a
  // User commits to scheduling or publishing (PRD stories 32–33, 36).
  if (status !== "draft") {
    if (platforms.length === 0) {
      return {
        ok: false,
        code: 400,
        body: { error: "no_platforms_selected", message: "Select at least one platform to publish to." },
      };
    }

    const notEnabled = platforms.find((platform) => !planEnables(plan, platform));
    if (notEnabled) {
      return {
        ok: false,
        code: 403,
        body: {
          error: "platform_not_enabled",
          message: `This Client's plan does not include ${notEnabled}.`,
        },
      };
    }

    for (const platform of platforms) {
      const account = await findAccount(pool, clientId, platform);
      if (account?.status !== "connected") {
        return {
          ok: false,
          code: 409,
          body: {
            error: "platform_not_connected",
            message: `Connect ${platform} before publishing to it.`,
          },
        };
      }
    }

    const validation = validateContent({ text, media: parsedMedia.media ?? undefined }, platforms);
    if (!validation.valid) {
      return {
        ok: false,
        code: 422,
        body: {
          error: "invalid_content",
          message: "This content doesn't satisfy every selected platform's requirements.",
          reasons: validation.reasons,
        },
      };
    }
  }

  return {
    ok: true,
    text,
    media: parsedMedia.media,
    mediaId: parsedMedia.mediaId,
    platforms,
    status,
    scheduledAt,
  };
}

export async function registerPostRoutes(app: FastifyInstance): Promise<void> {
  // Compose a Post: saved as a Draft, scheduled for later, or published
  // immediately (PRD stories 29–36) depending on the body's `draft`/`scheduledAt`.
  app.post<{ Body: ComposeBody }>("/api/posts", async (request, reply) => {
    const ctx = await authenticateClientRequest(request, reply);
    if (!ctx) return reply;

    const { pool, clock, publisher, mediaDir, mediaBaseUrl } = app.deps;
    const resolution = await resolveCompose(
      pool,
      clock,
      mediaBaseUrl,
      ctx.client.id,
      ctx.client.plan,
      request.body ?? {},
    );
    if (!resolution.ok) {
      return reply.code(resolution.code).send(resolution.body);
    }

    const { post, targets } = await createPost(pool, clock, {
      clientId: ctx.client.id,
      authorId: ctx.user.id,
      text: resolution.text,
      media: resolution.media,
      mediaId: resolution.mediaId,
      platforms: resolution.platforms,
      status: resolution.status,
      scheduledAt: resolution.scheduledAt,
    });

    // Only an immediate publish fans out right now — a Draft/Scheduled Post's
    // Targets stay `pending` until a User finishes it or the scheduler's tick
    // finds it due (PRD stories 35–36).
    const finalTargets =
      resolution.status === "publishing"
        ? await publishPost(pool, clock, publisher, mediaDir, post, targets)
        : targets;
    const final = await findPost(pool, ctx.client.id, post.id);

    return reply
      .code(201)
      .send({ post: postView(final ?? post), targets: finalTargets.map(targetView) });
  });

  // Edit a Draft or Scheduled Post before it fires (PRD stories 36–38): a full
  // replacement of its content, platform selection, and schedule, gated exactly
  // like compose unless the edit is itself saved back as a Draft.
  app.patch<{ Params: { id: string }; Body: ComposeBody }>(
    "/api/posts/:id",
    async (request, reply) => {
      const ctx = await authenticateClientRequest(request, reply);
      if (!ctx) return reply;

      const { pool, clock, mediaBaseUrl } = app.deps;
      const post = await findPost(pool, ctx.client.id, request.params.id);
      if (!post) {
        return reply.code(404).send({ error: "post_not_found" });
      }
      if (post.status !== "draft" && post.status !== "scheduled") {
        return reply.code(409).send({
          error: "not_editable",
          message: "Only a Draft or Scheduled Post can be edited before it fires.",
        });
      }

      const resolution = await resolveCompose(
        pool,
        clock,
        mediaBaseUrl,
        ctx.client.id,
        ctx.client.plan,
        request.body ?? {},
      );
      if (!resolution.ok) {
        return reply.code(resolution.code).send(resolution.body);
      }
      if (resolution.status === "publishing") {
        return reply.code(400).send({
          error: "missing_schedule",
          message: "Provide scheduledAt to keep this Post scheduled, or draft: true to save it as a Draft.",
        });
      }

      const updated = await updatePostContent(pool, clock, post.id, {
        text: resolution.text,
        media: resolution.media,
        mediaId: resolution.mediaId,
        status: resolution.status,
        scheduledAt: resolution.scheduledAt,
      });
      await replaceTargets(pool, clock, post.id, resolution.platforms);
      const targets = await listTargets(pool, post.id);

      return reply.code(200).send({ post: postView(updated), targets: targets.map(targetView) });
    },
  );

  // Cancel a Scheduled Post before it fires (PRD story 38): it never publishes,
  // and is left as a Draft — the same content, just no longer due at a fixed
  // time — rather than a dead end the User must recompose from scratch.
  app.post<{ Params: { id: string } }>("/api/posts/:id/cancel", async (request, reply) => {
    const ctx = await authenticateClientRequest(request, reply);
    if (!ctx) return reply;

    const { pool, clock } = app.deps;
    const post = await findPost(pool, ctx.client.id, request.params.id);
    if (!post) {
      return reply.code(404).send({ error: "post_not_found" });
    }
    if (post.status !== "scheduled") {
      return reply.code(409).send({
        error: "not_scheduled",
        message: "Only a Scheduled Post can be cancelled.",
      });
    }

    const updated = await updatePostContent(pool, clock, post.id, {
      text: post.text,
      media: post.media,
      mediaId: post.mediaId,
      status: "draft",
      scheduledAt: null,
    });
    return reply.code(200).send({ post: postView(updated) });
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

      const { pool, clock, publisher, mediaDir } = app.deps;
      const post = await findPost(pool, ctx.client.id, request.params.id);
      if (!post) {
        return reply.code(404).send({ error: "post_not_found" });
      }

      const result = await manualRetryTarget(pool, clock, publisher, mediaDir, post, platform);
      if (!result.ok) {
        if (result.reason === "media_purged") {
          return reply.code(409).send({
            error: "media_purged",
            message: "The attached media was purged after 24 hours; re-upload it before retrying.",
          });
        }
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

  // Re-upload after a purge (Slice 9; ADR 0003): attaches a freshly uploaded
  // Media to a Post that still has a failed Target, so a manual retry can
  // proceed. Only meaningful once there is something to retry.
  app.post<{ Params: { id: string }; Body: { mediaId?: unknown } }>(
    "/api/posts/:id/media",
    async (request, reply) => {
      const ctx = await authenticateClientRequest(request, reply);
      if (!ctx) return reply;

      const { pool, clock, mediaBaseUrl } = app.deps;
      const post = await findPost(pool, ctx.client.id, request.params.id);
      if (!post) {
        return reply.code(404).send({ error: "post_not_found" });
      }

      const targets = await listTargets(pool, post.id);
      if (!targets.some((target) => target.status === "failed")) {
        return reply.code(409).send({
          error: "nothing_to_retry",
          message: "This Post has no failed Target to retry.",
        });
      }

      const mediaId = request.body?.mediaId;
      if (typeof mediaId !== "string" || !mediaId) {
        return reply.code(400).send({ error: "invalid_media", message: "mediaId is required." });
      }
      const media = await findMedia(pool, ctx.client.id, mediaId);
      if (!media || media.status !== "active") {
        return reply.code(400).send({
          error: "invalid_media",
          message: "Upload media before attaching it.",
        });
      }

      const updated = await attachMedia(pool, clock, post.id, {
        mediaId: media.id,
        media: { url: mediaPublicUrl(mediaBaseUrl, media.id), type: media.type },
      });
      return reply.code(200).send({ post: postView(updated) });
    },
  );
}

function postView(post: Post) {
  return {
    id: post.id,
    text: post.text,
    media: post.media,
    status: post.status,
    scheduledAt: post.scheduledAt,
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
