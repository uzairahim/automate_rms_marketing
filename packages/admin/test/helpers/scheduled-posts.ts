import type { FastifyInstance } from "fastify";
// Which platforms exist is `@smma/core`'s to say, here as everywhere else.
import type { Platform } from "@smma/core";
// A **development-only** dependency on the Client-facing service (PRD #15).
// Scheduled Posts are that service's domain, and the consequence previews count
// them — so the Posts those counts are asserted against are composed through its
// real compose and scheduling logic rather than written as SQL, which could
// construct states the domain never produces: a Target for a platform the Plan
// never enabled, a `scheduled` Post with no `scheduled_at`, a Post whose Client
// never connected the account it targets. Nothing under `src/` imports any of
// this, so the admin service stays independently deployable.
import type { FakePublisher, PageSpec } from "../../../server/src/core/fake-publisher.js";

/** Headers that put a request on a Client's subdomain as one of its Users. */
export type ClientAuth = Record<string, string>;

/**
 * The Facebook Page the fake OAuth handshake offers, with an Instagram account
 * attached — one Page covers both Meta platforms, exactly as it does in real
 * life and in the Client-facing service's own suites.
 */
const PAGE_WITH_IG: PageSpec = {
  id: "page-a",
  name: "Acme Storefront",
  instagram: { id: "ig-acme", username: "acme.official" },
};

/**
 * Connect a Client's accounts for the given platforms, through the real OAuth
 * routes against the fake Publisher.
 *
 * Composing anything refuses a platform with no connected account, so this is
 * unavoidable setup rather than incidental detail — and driving the real
 * handshake is what keeps these fixtures honest about it.
 */
export async function connectPlatforms(
  app: FastifyInstance,
  publisher: FakePublisher,
  auth: ClientAuth,
  platforms: ReadonlyArray<Platform>,
): Promise<void> {
  if (platforms.includes("facebook") || platforms.includes("instagram")) {
    publisher.scriptPages(PAGE_WITH_IG);
    const start = await app.inject({
      method: "POST",
      url: "/api/connections/facebook/start",
      headers: auth,
    });
    const state = start.json().state as string;
    await app.inject({
      method: "POST",
      url: "/api/connections/facebook/callback",
      payload: { state, code: "auth-code" },
    });
    await app.inject({
      method: "POST",
      url: "/api/connections/facebook/select",
      payload: { state, pageId: PAGE_WITH_IG.id },
    });
  }
  if (platforms.includes("instagram")) {
    await app.inject({
      method: "POST",
      url: "/api/connections/instagram/connect",
      headers: auth,
    });
  }
  if (platforms.includes("tiktok")) {
    const start = await app.inject({
      method: "POST",
      url: "/api/connections/tiktok/start",
      headers: auth,
    });
    await app.inject({
      method: "POST",
      url: "/api/connections/tiktok/callback",
      payload: { state: start.json().state as string, code: "auth-code" },
    });
  }
}

/** Upload a video, so a Post can target Instagram or TikTok at all. */
async function uploadVideo(app: FastifyInstance, auth: ClientAuth): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/media",
    headers: { ...auth, "content-type": "video/mp4" },
    payload: Buffer.from("fake-bytes"),
  });
  if (res.statusCode !== 201) {
    throw new Error(`Media upload failed (${res.statusCode}): ${res.body}`);
  }
  return res.json().id as string;
}

/**
 * Schedule a Post through the Client-facing API, returning its id.
 *
 * A video is attached whenever a targeted platform requires media, so a caller
 * can name any platform set without restating each one's content rule.
 */
export async function schedulePost(
  app: FastifyInstance,
  auth: ClientAuth,
  input: {
    platforms: ReadonlyArray<Platform>;
    scheduledAt: Date;
    text?: string;
  },
): Promise<string> {
  const needsMedia = input.platforms.some((p) => p !== "facebook");
  const mediaId = needsMedia ? await uploadVideo(app, auth) : null;

  const res = await app.inject({
    method: "POST",
    url: "/api/posts",
    headers: auth,
    payload: {
      text: input.text ?? "hello",
      platforms: input.platforms,
      scheduledAt: input.scheduledAt.toISOString(),
      ...(mediaId ? { media: { mediaId } } : {}),
    },
  });
  if (res.statusCode !== 201) {
    throw new Error(`Scheduling failed (${res.statusCode}): ${res.body}`);
  }
  return res.json().post.id as string;
}
