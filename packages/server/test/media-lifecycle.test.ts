import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildTestApp } from "./helpers/app.js";
import { provisionAndLogin } from "./helpers/provision.js";
import { TestClock } from "../src/core/clock.js";
import { FakePublisher, type PageSpec } from "../src/core/fake-publisher.js";
import { startTestPostgres, type TestPostgres } from "./helpers/postgres.js";
import { retryDueTargets } from "../src/posts/retry.js";
import { purgeDueMedia } from "../src/media/media.js";

/**
 * Slice 9 behavioral suite — the Media lifecycle (ADR 0003): served over
 * HTTPS from compose through publish, deleted immediately once every Target
 * is Published, retained 24 hours after a partial/total failure so the User
 * can manually retry, and purged only once every Target is terminal — never
 * on a first success.
 */

const NOW = new Date("2026-07-20T09:00:00.000Z");
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

const PAGE_WITH_IG: PageSpec = {
  id: "page-a",
  name: "Acme Storefront",
  instagram: { id: "ig-acme", username: "acme.official" },
};

describe("Media lifecycle", () => {
  let db: TestPostgres;
  let app: FastifyInstance;
  let mediaDir: string;
  const clock = new TestClock(NOW);
  const publisher = new FakePublisher();

  beforeAll(async () => {
    db = await startTestPostgres();
    app = buildTestApp({ pool: db.pool, clock, publisher });
    await app.ready();
    mediaDir = app.deps.mediaDir;
  });

  afterAll(async () => {
    await app.close();
    await db.stop();
  });

  beforeEach(async () => {
    await db.pool.query(
      "TRUNCATE clients, users, sessions, connected_accounts, oauth_states, posts, media RESTART IDENTITY CASCADE",
    );
    publisher.reset();
    clock.set(NOW);
  });

  /** Provision a Client + User with the given Plan, and log that User in. */
  async function client(
    subdomain = "acme",
    plan: Record<string, boolean> = { facebook: true, instagram: true, tiktok: true },
  ): Promise<{ clientId: string; auth: Record<string, string> }> {
    return provisionAndLogin(app, db.pool, { subdomain, plan });
  }

  async function connectPlatforms(
    auth: Record<string, string>,
    platforms: Array<"facebook" | "instagram" | "tiktok">,
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
      await app.inject({ method: "POST", url: "/api/connections/instagram/connect", headers: auth });
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

  const compose = (auth: Record<string, string>, body: Record<string, unknown>) =>
    app.inject({ method: "POST", url: "/api/posts", headers: auth, payload: body });

  async function uploadMedia(
    auth: Record<string, string>,
    contentType = "image/png",
    bytes = Buffer.from("fake-image-bytes"),
  ): Promise<{ id: string; url: string }> {
    const res = await app.inject({
      method: "POST",
      url: "/api/media",
      headers: { ...auth, "content-type": contentType },
      payload: bytes,
    });
    expect(res.statusCode).toBe(201);
    return { id: res.json().id as string, url: res.json().url as string };
  }

  /** GET the media's own serve route by its returned public URL. */
  function fetchMedia(url: string) {
    const path = new URL(url).pathname;
    return app.inject({ method: "GET", url: path });
  }

  it("serves an uploaded Media over HTTPS at its public URL", async () => {
    const { auth } = await client();
    const bytes = Buffer.from("hello media");
    const { url } = await uploadMedia(auth, "image/png", bytes);

    expect(url).toMatch(/^https:\/\//);
    const res = await fetchMedia(url);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.rawPayload.equals(bytes)).toBe(true);
  });

  it("keeps Media reachable from compose through the publish attempt", async () => {
    const { auth } = await client();
    await connectPlatforms(auth, ["facebook"]);
    publisher.scriptFailure("facebook", "not yet");
    const { id, url } = await uploadMedia(auth, "video/mp4");

    await compose(auth, { text: "hi", media: { mediaId: id }, platforms: ["facebook"] });

    // Still pending its auto-retry (not yet terminal) — Media must still resolve.
    expect((await fetchMedia(url)).statusCode).toBe(200);
    expect(publisher.sentTo("facebook")[0]).toMatchObject({ mediaUrl: url });
  });

  it("deletes Media immediately once every Target is Published", async () => {
    const { auth } = await client();
    await connectPlatforms(auth, ["facebook", "tiktok"]);
    publisher.scriptSuccess("facebook", "fb-ok");
    publisher.scriptSuccess("tiktok", "tt-ok");
    const { id, url } = await uploadMedia(auth, "video/mp4");

    const res = await compose(auth, { text: "hi", media: { mediaId: id }, platforms: ["facebook", "tiktok"] });

    expect(res.json().post.status).toBe("published");
    expect((await fetchMedia(url)).statusCode).toBe(404);
  });

  it("retains Media while any Target is still non-terminal, even long after", async () => {
    const { auth } = await client();
    await connectPlatforms(auth, ["facebook"]);
    publisher.scriptFailure("facebook", "temporary");
    const { id } = await uploadMedia(auth, "image/png");

    const res = await compose(auth, { text: "hi", media: { mediaId: id }, platforms: ["facebook"] });
    expect(res.json().post.status).toBe("publishing"); // pending its first auto-retry

    // Time passes well past the 24h purge window, but no retry tick has run —
    // the Target is still non-terminal, so the purge job must never touch it.
    clock.advance(ONE_DAY_MS * 2);
    const purged = await purgeDueMedia(db.pool, clock, mediaDir);
    expect(purged).toBe(0);

    const composedMediaUrl = res.json().post.media.url as string;
    expect((await fetchMedia(composedMediaUrl)).statusCode).toBe(200);
  });

  it("retains Media 24h after a partial failure, then purges it", async () => {
    const { auth } = await client();
    await connectPlatforms(auth, ["facebook", "tiktok"]);
    publisher.scriptSuccess("facebook", "fb-ok");
    publisher.scriptFailure("tiktok", "TikTok rejected the video.");
    const { id, url } = await uploadMedia(auth, "video/mp4");

    const composeRes = await compose(auth, {
      text: "hi",
      media: { mediaId: id },
      platforms: ["facebook", "tiktok"],
    });
    expect(composeRes.json().post.status).toBe("publishing");

    // Exhaust TikTok's two auto-retries so the roll-up settles to Partially
    // Published — only then is the 24h purge window scheduled.
    clock.advance(60_000);
    await retryDueTargets(db.pool, clock, publisher, app.deps.tokenCipher, mediaDir);
    clock.advance(60_000);
    const outcome = await retryDueTargets(db.pool, clock, publisher, app.deps.tokenCipher, mediaDir);
    expect(outcome.failed).toBe(1);

    const final = await app.inject({
      method: "GET",
      url: `/api/posts/${composeRes.json().post.id}`,
      headers: auth,
    });
    expect(final.json().post.status).toBe("partially_published");

    // Still available right after settling — not purged on Facebook's success.
    expect((await fetchMedia(url)).statusCode).toBe(200);

    // Just under 24h since the failure settled: still retained.
    clock.advance(ONE_DAY_MS - 1000);
    expect(await purgeDueMedia(db.pool, clock, mediaDir)).toBe(0);
    expect((await fetchMedia(url)).statusCode).toBe(200);

    // 24h since the failure settled: purged.
    clock.advance(1000);
    expect(await purgeDueMedia(db.pool, clock, mediaDir)).toBe(1);
    expect((await fetchMedia(url)).statusCode).toBe(404);
  });

  it("blocks a manual retry after the Media has been purged", async () => {
    const { auth } = await client();
    await connectPlatforms(auth, ["facebook"]);
    publisher.scriptFailure("facebook", "Persistent failure.");
    const { id } = await uploadMedia(auth, "image/png");

    const composeRes = await compose(auth, { text: "hi", media: { mediaId: id }, platforms: ["facebook"] });
    const postId = composeRes.json().post.id as string;

    clock.advance(60_000);
    await retryDueTargets(db.pool, clock, publisher, app.deps.tokenCipher, mediaDir);
    clock.advance(60_000);
    await retryDueTargets(db.pool, clock, publisher, app.deps.tokenCipher, mediaDir);

    clock.advance(ONE_DAY_MS);
    expect(await purgeDueMedia(db.pool, clock, mediaDir)).toBe(1);

    const sentBefore = publisher.sentTo("facebook").length;
    publisher.scriptSuccess("facebook", "should-not-be-used");
    const retryRes = await app.inject({
      method: "POST",
      url: `/api/posts/${postId}/targets/facebook/retry`,
      headers: auth,
    });

    expect(retryRes.statusCode).toBe(409);
    expect(retryRes.json().error).toBe("media_purged");
    // No new publish attempt was made against the dead Media.
    expect(publisher.sentTo("facebook")).toHaveLength(sentBefore);
  });

  it("lets a re-uploaded Media unblock a retry after purge", async () => {
    const { auth } = await client();
    await connectPlatforms(auth, ["facebook"]);
    publisher.scriptFailure("facebook", "Persistent failure.");
    const { id } = await uploadMedia(auth, "image/png");

    const composeRes = await compose(auth, { text: "hi", media: { mediaId: id }, platforms: ["facebook"] });
    const postId = composeRes.json().post.id as string;

    clock.advance(60_000);
    await retryDueTargets(db.pool, clock, publisher, app.deps.tokenCipher, mediaDir);
    clock.advance(60_000);
    await retryDueTargets(db.pool, clock, publisher, app.deps.tokenCipher, mediaDir);
    clock.advance(ONE_DAY_MS);
    await purgeDueMedia(db.pool, clock, mediaDir);

    const fresh = await uploadMedia(auth, "image/png", Buffer.from("re-uploaded"));
    const attach = await app.inject({
      method: "POST",
      url: `/api/posts/${postId}/media`,
      headers: auth,
      payload: { mediaId: fresh.id },
    });
    expect(attach.statusCode).toBe(200);
    expect(attach.json().post.media.url).toBe(fresh.url);

    publisher.scriptSuccess("facebook", "fb-recovered");
    const retryRes = await app.inject({
      method: "POST",
      url: `/api/posts/${postId}/targets/facebook/retry`,
      headers: auth,
    });
    expect(retryRes.statusCode).toBe(200);
    expect(retryRes.json().post.status).toBe("published");
    expect(publisher.sentTo("facebook").at(-1)).toMatchObject({ mediaUrl: fresh.url });
  });

  it("refuses to attach Media to a Post with nothing to retry", async () => {
    const { auth } = await client();
    await connectPlatforms(auth, ["facebook"]);
    publisher.scriptSuccess("facebook", "fb-ok");
    const { id } = await uploadMedia(auth, "image/png");
    const composeRes = await compose(auth, { text: "hi", media: { mediaId: id }, platforms: ["facebook"] });
    const postId = composeRes.json().post.id as string;

    const fresh = await uploadMedia(auth, "image/png");
    const res = await app.inject({
      method: "POST",
      url: `/api/posts/${postId}/media`,
      headers: auth,
      payload: { mediaId: fresh.id },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("nothing_to_retry");
  });

  it("rejects an upload whose content type is neither image nor video", async () => {
    const { auth } = await client();
    const res = await app.inject({
      method: "POST",
      url: "/api/media",
      headers: { ...auth, "content-type": "audio/mpeg" },
      payload: Buffer.from("nope"),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("unsupported_media_type");
  });
});
