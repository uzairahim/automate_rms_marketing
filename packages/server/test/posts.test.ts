import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildTestApp, TEST_BASE_DOMAIN, TEST_SUPERADMIN_TOKEN } from "./helpers/app.js";
import { TestClock } from "../src/core/clock.js";
import { FakePublisher, type PageSpec } from "../src/core/fake-publisher.js";
import { startTestPostgres, type TestPostgres } from "./helpers/postgres.js";
import { retryDueTargets } from "../src/posts/retry.js";

/**
 * Slice 8 behavioral suite — compose, validate-and-gate, and immediate publish,
 * driven through the real Fastify API against a real, throwaway Postgres.
 *
 * The fake Publisher is scripted per platform to succeed or fail, so fan-out,
 * independent per-Target outcomes, retries, and status roll-ups are
 * deterministic — no real Meta/TikTok call is ever made (PRD Testing Decisions).
 */

const ADMIN_HOST = `admin.${TEST_BASE_DOMAIN}`;
const host = (subdomain: string) => `${subdomain}.${TEST_BASE_DOMAIN}`;
const PASSWORD = "correct horse battery";
const NOW = new Date("2026-07-20T09:00:00.000Z");

const PAGE_WITH_IG: PageSpec = {
  id: "page-a",
  name: "Acme Storefront",
  instagram: { id: "ig-acme", username: "acme.official" },
};

describe("Compose + validate-and-gate + immediate publish", () => {
  let db: TestPostgres;
  let app: FastifyInstance;
  let mediaDir: string;
  const clock = new TestClock(NOW);
  const publisher = new FakePublisher();

  const adminAuth = { authorization: `Bearer ${TEST_SUPERADMIN_TOKEN}` };

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

  /** Upload an image/video and return its mediaId, for compose's `media: { mediaId }`. */
  async function uploadMedia(
    auth: Record<string, string>,
    contentType: string,
    bytes = Buffer.from("fake-bytes"),
  ): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/api/media",
      headers: { ...auth, "content-type": contentType },
      payload: bytes,
    });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  }

  /** Provision a Client + User with the given Plan, and log in. */
  async function client(
    subdomain = "acme",
    plan: Record<string, boolean> = { facebook: true, instagram: true, tiktok: true },
  ): Promise<{ clientId: string; auth: Record<string, string> }> {
    const clientRes = await app.inject({
      method: "POST",
      url: "/api/admin/clients",
      headers: { host: ADMIN_HOST, ...adminAuth },
      payload: { subdomain, timezone: "America/New_York", plan },
    });
    expect(clientRes.statusCode).toBe(201);
    const clientId = clientRes.json().id as string;

    const email = `u@${subdomain}.test`;
    const userRes = await app.inject({
      method: "POST",
      url: `/api/admin/clients/${clientId}/users`,
      headers: { host: ADMIN_HOST, ...adminAuth },
      payload: { email, password: PASSWORD },
    });
    expect(userRes.statusCode).toBe(201);

    const loginRes = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { host: host(subdomain) },
      payload: { email, password: PASSWORD },
    });
    expect(loginRes.statusCode).toBe(200);

    return {
      clientId,
      auth: {
        host: host(subdomain),
        authorization: `Bearer ${loginRes.json().token as string}`,
      },
    };
  }

  /** Connect Facebook (and, if asked, Instagram/TikTok) for a logged-in Client. */
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

  const compose = (auth: Record<string, string>, body: Record<string, unknown>) =>
    app.inject({ method: "POST", url: "/api/posts", headers: auth, payload: body });

  describe("Validate-and-gate", () => {
    it("blocks a text-only Post to TikTok with an inline reason", async () => {
      const { auth } = await client();
      await connectPlatforms(auth, ["tiktok"]);

      const res = await compose(auth, { text: "hello", platforms: ["tiktok"] });

      expect(res.statusCode).toBe(422);
      expect(res.json().error).toBe("invalid_content");
      expect(res.json().reasons.tiktok).toMatch(/video/i);
      expect(publisher.sent).toHaveLength(0);
    });

    it("blocks an image-only Post to TikTok — it specifically requires a video", async () => {
      const { auth } = await client();
      await connectPlatforms(auth, ["tiktok"]);
      const mediaId = await uploadMedia(auth, "image/png");

      const res = await compose(auth, {
        text: "hello",
        media: { mediaId },
        platforms: ["tiktok"],
      });

      expect(res.statusCode).toBe(422);
      expect(res.json().reasons.tiktok).toMatch(/video/i);
    });

    it("blocks a Post with no media to Instagram", async () => {
      const { auth } = await client();
      await connectPlatforms(auth, ["instagram"]);

      const res = await compose(auth, { text: "hello", platforms: ["instagram"] });

      expect(res.statusCode).toBe(422);
      expect(res.json().reasons.instagram).toMatch(/instagram requires/i);
    });

    it("allows a text-only Post to Facebook — it is permissive", async () => {
      const { auth } = await client();
      await connectPlatforms(auth, ["facebook"]);

      const res = await compose(auth, { text: "hello", platforms: ["facebook"] });

      expect(res.statusCode).toBe(201);
    });

    it("checks the union of every selected platform's rules at once", async () => {
      const { auth } = await client();
      await connectPlatforms(auth, ["facebook", "instagram", "tiktok"]);
      const mediaId = await uploadMedia(auth, "image/png");

      const res = await compose(auth, {
        text: "hello",
        media: { mediaId },
        platforms: ["facebook", "instagram", "tiktok"],
      });

      // Instagram is satisfied by the image; only TikTok's reason surfaces.
      expect(res.statusCode).toBe(422);
      expect(Object.keys(res.json().reasons)).toEqual(["tiktok"]);
    });

    it("requires selecting at least one platform", async () => {
      const { auth } = await client();
      const res = await compose(auth, { text: "hello", platforms: [] });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("no_platforms_selected");
    });

    it("rejects composing with a mediaId that was never uploaded", async () => {
      const { auth } = await client();
      const res = await compose(auth, {
        text: "hello",
        media: { mediaId: "00000000-0000-0000-0000-000000000000" },
        platforms: ["facebook"],
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("invalid_media");
    });

    it("rejects composing with another Client's mediaId", async () => {
      const acme = await client("acme");
      const globex = await client("globex", { facebook: true, instagram: true, tiktok: true });
      const mediaId = await uploadMedia(acme.auth, "image/png");

      const res = await compose(globex.auth, {
        text: "hello",
        media: { mediaId },
        platforms: ["facebook"],
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("invalid_media");
    });
  });

  describe("Gating before publish", () => {
    it("refuses a platform the Client's Plan does not enable", async () => {
      const { auth } = await client("globex", { facebook: true });
      const res = await compose(auth, { text: "hello", platforms: ["tiktok"] });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("platform_not_enabled");
    });

    it("refuses a platform with nothing connected", async () => {
      const { auth } = await client();
      const res = await compose(auth, { text: "hello", platforms: ["facebook"] });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("platform_not_connected");
    });

    it("requires an authenticated session", async () => {
      await client();
      const res = await app.inject({
        method: "POST",
        url: "/api/posts",
        headers: { host: host("acme") },
        payload: { text: "hello", platforms: ["facebook"] },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe("Immediate publish fan-out", () => {
    it("publishes to every selected platform independently and reports Published", async () => {
      const { auth } = await client();
      await connectPlatforms(auth, ["facebook", "instagram", "tiktok"]);
      publisher.scriptSuccess("facebook", "fb-post-1", "https://facebook.test/p/1");
      publisher.scriptSuccess("instagram", "ig-post-1");
      publisher.scriptSuccess("tiktok", "tt-post-1");
      const mediaId = await uploadMedia(auth, "video/mp4");

      const res = await compose(auth, {
        text: "New arrivals!",
        media: { mediaId },
        platforms: ["facebook", "instagram", "tiktok"],
      });

      expect(res.statusCode).toBe(201);
      expect(res.json().post.status).toBe("published");
      const targets = res.json().targets as Array<{ platform: string; status: string; externalId: string }>;
      expect(targets).toHaveLength(3);
      for (const t of targets) expect(t.status).toBe("published");
      expect(targets.find((t) => t.platform === "facebook")?.externalId).toBe("fb-post-1");

      // Each transport got its own request, all carrying the same content.
      expect(publisher.sentTo("facebook")).toMatchObject([{ text: "New arrivals!" }]);
      expect(publisher.sentTo("instagram")).toHaveLength(1);
      expect(publisher.sentTo("tiktok")).toHaveLength(1);
    });

    it("persists the platform's post id per Target", async () => {
      const { auth } = await client();
      await connectPlatforms(auth, ["facebook"]);
      publisher.scriptSuccess("facebook", "fb-post-42", "https://facebook.test/p/42");

      await compose(auth, { text: "hi", platforms: ["facebook"] });

      const { rows } = await db.pool.query(
        "SELECT external_id, permalink FROM targets WHERE platform = 'facebook'",
      );
      expect(rows).toEqual([{ external_id: "fb-post-42", permalink: "https://facebook.test/p/42" }]);
    });

    it("does not roll back a successful Target when another platform fails", async () => {
      const { auth } = await client();
      await connectPlatforms(auth, ["facebook", "tiktok"]);
      publisher.scriptSuccess("facebook", "fb-ok");
      publisher.scriptFailure("tiktok", "TikTok rejected the video.");
      const mediaId = await uploadMedia(auth, "video/mp4");

      const res = await compose(auth, {
        text: "hi",
        media: { mediaId },
        platforms: ["facebook", "tiktok"],
      });

      expect(res.statusCode).toBe(201);
      // TikTok is still pending its auto-retry, so the roll-up is Publishing —
      // but Facebook already succeeded and is never touched by TikTok's failure.
      expect(res.json().post.status).toBe("publishing");
      const postId = res.json().post.id as string;
      const targets = res.json().targets as Array<{ platform: string; status: string }>;
      expect(targets.find((t) => t.platform === "facebook")?.status).toBe("published");
      expect(targets.find((t) => t.platform === "tiktok")?.status).toBe("pending");

      // Once TikTok's auto-retries are exhausted, the roll-up settles to
      // Partially Published — Facebook's success was never rolled back.
      clock.advance(60_000);
      await retryDueTargets(db.pool, clock, publisher, mediaDir);
      clock.advance(60_000);
      await retryDueTargets(db.pool, clock, publisher, mediaDir);

      const final = await app.inject({ method: "GET", url: `/api/posts/${postId}`, headers: auth });
      expect(final.json().post.status).toBe("partially_published");
      const finalTargets = final.json().targets as Array<{ platform: string; status: string }>;
      expect(finalTargets.find((t) => t.platform === "facebook")).toMatchObject({
        status: "published",
        externalId: "fb-ok",
      });
      expect(finalTargets.find((t) => t.platform === "tiktok")?.status).toBe("failed");
    });

    it("reports Failed when every Target fails", async () => {
      const { auth } = await client();
      await connectPlatforms(auth, ["facebook"]);
      publisher.scriptFailure("facebook", "Facebook rejected the post.");

      const res = await compose(auth, { text: "hi", platforms: ["facebook"] });

      expect(res.statusCode).toBe(201);
      // Still "publishing" immediately after the first attempt — the Target is
      // pending its first auto-retry, not terminal yet.
      expect(res.json().post.status).toBe("publishing");
      expect(res.json().targets[0]).toMatchObject({ status: "pending", retryCount: 1 });
    });
  });

  describe("Auto-retry (twice at one-minute intervals)", () => {
    it("retries a failed Target automatically and eventually reports Published", async () => {
      const { auth } = await client();
      await connectPlatforms(auth, ["facebook"]);
      publisher.scriptFailure("facebook", "Temporary glitch.");

      const composeRes = await compose(auth, { text: "hi", platforms: ["facebook"] });
      const postId = composeRes.json().post.id as string;
      expect(composeRes.json().targets[0]).toMatchObject({ status: "pending", retryCount: 1 });

      publisher.scriptSuccess("facebook", "fb-recovered");
      clock.advance(60_000);

      const outcome = await retryDueTargets(db.pool, clock, publisher, mediaDir);
      expect(outcome).toMatchObject({ attempted: 1, published: 1, failed: 0 });

      const res = await app.inject({ method: "GET", url: `/api/posts/${postId}`, headers: auth });
      expect(res.json().post.status).toBe("published");
      expect(res.json().targets[0]).toMatchObject({ status: "published", externalId: "fb-recovered" });
    });

    it("stops after two auto-retries and leaves the Target Failed", async () => {
      const { auth } = await client();
      await connectPlatforms(auth, ["facebook"]);
      publisher.scriptFailure("facebook", "Persistent failure.");

      const composeRes = await compose(auth, { text: "hi", platforms: ["facebook"] });
      const postId = composeRes.json().post.id as string;

      clock.advance(60_000);
      expect(await retryDueTargets(db.pool, clock, publisher, mediaDir)).toMatchObject({
        attempted: 1,
        failed: 0,
      });
      let target = (await getPost(auth, postId)).targets[0];
      expect(target).toMatchObject({ status: "pending", retryCount: 2 });

      clock.advance(60_000);
      expect(await retryDueTargets(db.pool, clock, publisher, mediaDir)).toMatchObject({
        attempted: 1,
        failed: 1,
      });
      const final = await getPost(auth, postId);
      expect(final.post.status).toBe("failed");
      target = final.targets[0];
      expect(target).toMatchObject({ status: "failed", retryCount: 2, error: "Persistent failure." });
    });

    async function getPost(auth: Record<string, string>, postId: string) {
      const res = await app.inject({ method: "GET", url: `/api/posts/${postId}`, headers: auth });
      return res.json() as {
        post: { status: string };
        targets: Array<{ platform: string; status: string; retryCount: number; error: string | null }>;
      };
    }
  });

  describe("Manual retry", () => {
    it("lets a User retry a Target the auto-retry chain gave up on", async () => {
      const { auth } = await client();
      await connectPlatforms(auth, ["facebook"]);
      publisher.scriptFailure("facebook", "Down for maintenance.");
      const composeRes = await compose(auth, { text: "hi", platforms: ["facebook"] });
      const postId = composeRes.json().post.id as string;

      clock.advance(60_000);
      await retryDueTargets(db.pool, clock, publisher, mediaDir);
      clock.advance(60_000);
      await retryDueTargets(db.pool, clock, publisher, mediaDir);

      publisher.scriptSuccess("facebook", "fb-manual-recovery");
      const res = await app.inject({
        method: "POST",
        url: `/api/posts/${postId}/targets/facebook/retry`,
        headers: auth,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().post.status).toBe("published");
      expect(res.json().targets[0]).toMatchObject({
        status: "published",
        externalId: "fb-manual-recovery",
      });
    });

    it("refuses to retry a Target that is not Failed", async () => {
      const { auth } = await client();
      await connectPlatforms(auth, ["facebook"]);
      publisher.scriptSuccess("facebook", "fb-ok");
      const composeRes = await compose(auth, { text: "hi", platforms: ["facebook"] });
      const postId = composeRes.json().post.id as string;

      const res = await app.inject({
        method: "POST",
        url: `/api/posts/${postId}/targets/facebook/retry`,
        headers: auth,
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("target_not_failed");
    });

    it("404s a Post that doesn't belong to the requesting Client", async () => {
      const acme = await client("acme");
      const globex = await client("globex", { facebook: true, instagram: true, tiktok: true });
      await connectPlatforms(acme.auth, ["facebook"]);
      const composeRes = await compose(acme.auth, { text: "hi", platforms: ["facebook"] });
      const postId = composeRes.json().post.id as string;

      const res = await app.inject({
        method: "GET",
        url: `/api/posts/${postId}`,
        headers: globex.auth,
      });
      expect(res.statusCode).toBe(404);
    });
  });
});
