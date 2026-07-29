import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildTestApp, TEST_BASE_DOMAIN, TEST_SUPERADMIN_TOKEN } from "./helpers/app.js";
import { TestClock } from "../src/core/clock.js";
import { FakePublisher, type PageSpec } from "../src/core/fake-publisher.js";
import { startTestPostgres, type TestPostgres } from "./helpers/postgres.js";
import { publishDuePosts, GRACE_WINDOW_MS } from "../src/posts/scheduling.js";

/**
 * Slice 10 behavioral suite — drafts, scheduling, editing/cancelling before a
 * Post fires, and the scheduler's due/grace/missed logic (issue #11).
 *
 * The scheduler tick is exercised by calling {@link publishDuePosts} directly
 * against the injected {@link TestClock}, the same approach `retryDueTargets`
 * uses in the compose suite — no real waiting, and no BullMQ needed to prove
 * the domain logic (PRD Testing Decisions: "inject a clock").
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

describe("Scheduling + grace window + drafts", () => {
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

  const editPost = (auth: Record<string, string>, id: string, body: Record<string, unknown>) =>
    app.inject({ method: "PATCH", url: `/api/posts/${id}`, headers: auth, payload: body });

  const cancelPost = (auth: Record<string, string>, id: string) =>
    app.inject({ method: "POST", url: `/api/posts/${id}/cancel`, headers: auth });

  const getPost = (auth: Record<string, string>, id: string) =>
    app.inject({ method: "GET", url: `/api/posts/${id}`, headers: auth });

  const future = (ms: number) => new Date(clock.now().getTime() + ms).toISOString();

  describe("Drafts", () => {
    it("saves a Post as a Draft even with incomplete, ungated content", async () => {
      const { auth } = await client();

      const res = await compose(auth, { text: "", platforms: [], draft: true });

      expect(res.statusCode).toBe(201);
      expect(res.json().post.status).toBe("draft");
      expect(res.json().post.scheduledAt).toBeNull();
      expect(publisher.sent).toHaveLength(0);
    });

    it("lets a User return and finish a Draft, scheduling it via edit", async () => {
      const { auth } = await client();
      await connectPlatforms(auth, ["facebook"]);
      const draftRes = await compose(auth, { text: "", platforms: [], draft: true });
      const postId = draftRes.json().post.id as string;

      const scheduledAt = future(60 * 60 * 1000);
      const res = await editPost(auth, postId, {
        text: "Finished at last",
        platforms: ["facebook"],
        scheduledAt,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().post.status).toBe("scheduled");
      expect(res.json().post.scheduledAt).toBe(scheduledAt);
      expect(res.json().targets).toHaveLength(1);
    });
  });

  describe("Scheduling", () => {
    it("schedules a Post for a future time in the Client's timezone (stored as UTC)", async () => {
      const { auth } = await client();
      await connectPlatforms(auth, ["facebook"]);
      const scheduledAt = future(2 * 60 * 60 * 1000);

      const res = await compose(auth, { text: "hi", platforms: ["facebook"], scheduledAt });

      expect(res.statusCode).toBe(201);
      expect(res.json().post.status).toBe("scheduled");
      expect(res.json().post.scheduledAt).toBe(scheduledAt);
      expect(res.json().targets[0]).toMatchObject({ status: "pending" });
      // Nothing is attempted at schedule time — only the tick fires it.
      expect(publisher.sent).toHaveLength(0);
    });

    it("blocks scheduling a Post whose content is invalid for a selected platform", async () => {
      const { auth } = await client();
      await connectPlatforms(auth, ["tiktok"]);

      const res = await compose(auth, {
        text: "hello",
        platforms: ["tiktok"],
        scheduledAt: future(60 * 60 * 1000),
      });

      expect(res.statusCode).toBe(422);
      expect(res.json().error).toBe("invalid_content");
      expect(res.json().reasons.tiktok).toMatch(/video/i);
    });

    it("rejects scheduling a Post in the past", async () => {
      const { auth } = await client();
      await connectPlatforms(auth, ["facebook"]);

      const res = await compose(auth, {
        text: "hi",
        platforms: ["facebook"],
        scheduledAt: new Date(clock.now().getTime() - 1000).toISOString(),
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("scheduled_time_in_past");
    });

    it("refuses to schedule to a platform with nothing connected", async () => {
      const { auth } = await client();

      const res = await compose(auth, {
        text: "hi",
        platforms: ["facebook"],
        scheduledAt: future(60 * 60 * 1000),
      });

      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("platform_not_connected");
    });
  });

  describe("Editing and cancelling before it fires", () => {
    it("edits a Scheduled Post's time and content before it fires", async () => {
      const { auth } = await client();
      await connectPlatforms(auth, ["facebook"]);
      const composeRes = await compose(auth, {
        text: "original",
        platforms: ["facebook"],
        scheduledAt: future(60 * 60 * 1000),
      });
      const postId = composeRes.json().post.id as string;

      const newTime = future(3 * 60 * 60 * 1000);
      const res = await editPost(auth, postId, {
        text: "corrected",
        platforms: ["facebook"],
        scheduledAt: newTime,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().post.text).toBe("corrected");
      expect(res.json().post.scheduledAt).toBe(newTime);
      expect(res.json().post.status).toBe("scheduled");
    });

    it("refuses to edit a Post that has already started publishing", async () => {
      const { auth } = await client();
      await connectPlatforms(auth, ["facebook"]);
      publisher.scriptSuccess("facebook", "fb-1");
      const composeRes = await compose(auth, { text: "hi", platforms: ["facebook"] });
      const postId = composeRes.json().post.id as string;

      const res = await editPost(auth, postId, { text: "too late", platforms: ["facebook"] });

      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("not_editable");
    });

    it("404s editing a Post that doesn't belong to the requesting Client", async () => {
      const acme = await client("acme");
      const globex = await client("globex", { facebook: true, instagram: true, tiktok: true });
      await connectPlatforms(acme.auth, ["facebook"]);
      const composeRes = await compose(acme.auth, {
        text: "hi",
        platforms: ["facebook"],
        scheduledAt: future(60 * 60 * 1000),
      });
      const postId = composeRes.json().post.id as string;

      const res = await editPost(globex.auth, postId, { text: "hijack", platforms: ["facebook"] });
      expect(res.statusCode).toBe(404);
    });

    it("cancels a Scheduled Post, leaving it a Draft that never publishes", async () => {
      const { auth } = await client();
      await connectPlatforms(auth, ["facebook"]);
      publisher.scriptSuccess("facebook", "fb-1");
      const composeRes = await compose(auth, {
        text: "hi",
        platforms: ["facebook"],
        scheduledAt: future(30 * 60 * 1000),
      });
      const postId = composeRes.json().post.id as string;

      const cancelRes = await cancelPost(auth, postId);
      expect(cancelRes.statusCode).toBe(200);
      expect(cancelRes.json().post.status).toBe("draft");
      expect(cancelRes.json().post.scheduledAt).toBeNull();

      // Advance well past the original fire time and run the tick — it must
      // never publish a cancelled (now Draft) Post.
      clock.advance(2 * 60 * 60 * 1000);
      const outcome = await publishDuePosts(db.pool, clock, publisher, app.deps.tokenCipher, mediaDir);
      expect(outcome).toMatchObject({ due: 0, fired: 0, missed: 0 });
      expect(publisher.sent).toHaveLength(0);

      const final = await getPost(auth, postId);
      expect(final.json().post.status).toBe("draft");
    });

    it("409s cancelling a Post that isn't Scheduled", async () => {
      const { auth } = await client();
      const draftRes = await compose(auth, { text: "", platforms: [], draft: true });
      const postId = draftRes.json().post.id as string;

      const res = await cancelPost(auth, postId);
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("not_scheduled");
    });

    it("404s cancelling a Post that doesn't exist", async () => {
      const { auth } = await client();
      const res = await cancelPost(auth, "00000000-0000-0000-0000-000000000000");
      expect(res.statusCode).toBe(404);
    });
  });

  describe("The scheduler's minute tick — due, grace window, missed", () => {
    it("leaves a Scheduled Post untouched before it is due", async () => {
      const { auth } = await client();
      await connectPlatforms(auth, ["facebook"]);
      publisher.scriptSuccess("facebook", "fb-1");
      await compose(auth, { text: "hi", platforms: ["facebook"], scheduledAt: future(60 * 60 * 1000) });

      clock.advance(30 * 60 * 1000); // still 30 minutes early
      const outcome = await publishDuePosts(db.pool, clock, publisher, app.deps.tokenCipher, mediaDir);

      expect(outcome).toEqual({ due: 0, fired: 0, missed: 0 });
      expect(publisher.sent).toHaveLength(0);
    });

    it("publishes a due Scheduled Post via the fan-out, exactly like an immediate publish", async () => {
      const { auth } = await client();
      await connectPlatforms(auth, ["facebook", "tiktok"]);
      publisher.scriptSuccess("facebook", "fb-sched-1", "https://facebook.test/p/1");
      publisher.scriptSuccess("tiktok", "tt-sched-1");
      const mediaId = await uploadVideo(auth);

      const composeRes = await compose(auth, {
        text: "Scheduled launch",
        media: { mediaId },
        platforms: ["facebook", "tiktok"],
        scheduledAt: future(15 * 60 * 1000),
      });
      const postId = composeRes.json().post.id as string;

      clock.advance(15 * 60 * 1000);
      const outcome = await publishDuePosts(db.pool, clock, publisher, app.deps.tokenCipher, mediaDir);
      expect(outcome).toEqual({ due: 1, fired: 1, missed: 0 });

      const final = await getPost(auth, postId);
      expect(final.json().post.status).toBe("published");
      // scheduledAt is only live while a Post is actually `scheduled` — once
      // fired, it no longer means anything and must not linger.
      expect(final.json().post.scheduledAt).toBeNull();
      const targets = final.json().targets as Array<{ platform: string; status: string }>;
      expect(targets.every((t) => t.status === "published")).toBe(true);
      expect(publisher.sentTo("facebook")).toMatchObject([{ text: "Scheduled launch" }]);
    });

    it("still fires a Post picked up within the 60-minute grace window after an outage", async () => {
      const { auth } = await client();
      await connectPlatforms(auth, ["facebook"]);
      publisher.scriptSuccess("facebook", "fb-recovered");
      const composeRes = await compose(auth, {
        text: "hi",
        platforms: ["facebook"],
        scheduledAt: future(5 * 60 * 1000),
      });
      const postId = composeRes.json().post.id as string;

      // The worker was "down" well past the fire time, but recovers inside
      // the grace window (< 60 minutes late).
      clock.advance(5 * 60 * 1000 + GRACE_WINDOW_MS - 60_000);
      const outcome = await publishDuePosts(db.pool, clock, publisher, app.deps.tokenCipher, mediaDir);

      expect(outcome).toEqual({ due: 1, fired: 1, missed: 0 });
      const final = await getPost(auth, postId);
      expect(final.json().post.status).toBe("published");
    });

    it("fires a Post exactly 60 minutes late — the grace window's own boundary", async () => {
      const { auth } = await client();
      await connectPlatforms(auth, ["facebook"]);
      publisher.scriptSuccess("facebook", "fb-on-the-boundary");
      const composeRes = await compose(auth, {
        text: "hi",
        platforms: ["facebook"],
        scheduledAt: future(5 * 60 * 1000),
      });
      const postId = composeRes.json().post.id as string;

      // "More than 60 minutes late" is Failed — exactly 60 minutes is not yet
      // "more than", so it must still fire.
      clock.advance(5 * 60 * 1000 + GRACE_WINDOW_MS);
      const outcome = await publishDuePosts(db.pool, clock, publisher, app.deps.tokenCipher, mediaDir);

      expect(outcome).toEqual({ due: 1, fired: 1, missed: 0 });
      const final = await getPost(auth, postId);
      expect(final.json().post.status).toBe("published");
    });

    it("marks a badly-late Post Failed without publishing once past the grace window", async () => {
      const { auth } = await client();
      await connectPlatforms(auth, ["facebook"]);
      publisher.scriptSuccess("facebook", "fb-would-have-fired");
      const composeRes = await compose(auth, {
        text: "hi",
        platforms: ["facebook"],
        scheduledAt: future(5 * 60 * 1000),
      });
      const postId = composeRes.json().post.id as string;

      clock.advance(5 * 60 * 1000 + GRACE_WINDOW_MS + 60_000); // 1 minute past grace
      const outcome = await publishDuePosts(db.pool, clock, publisher, app.deps.tokenCipher, mediaDir);

      expect(outcome).toEqual({ due: 1, fired: 0, missed: 1 });
      expect(publisher.sent).toHaveLength(0); // never attempted — no embarrassing late post

      const final = await getPost(auth, postId);
      expect(final.json().post.status).toBe("failed");
      expect(final.json().post.scheduledAt).toBeNull();
      const targets = final.json().targets as Array<{ platform: string; status: string; error: string }>;
      expect(targets[0]).toMatchObject({ status: "failed" });
      expect(targets[0]!.error).toMatch(/grace window/i);
    });

    it("is safe to run repeatedly — a Post already fired is not found due again", async () => {
      const { auth } = await client();
      await connectPlatforms(auth, ["facebook"]);
      publisher.scriptSuccess("facebook", "fb-once");
      await compose(auth, { text: "hi", platforms: ["facebook"], scheduledAt: future(60_000) });

      clock.advance(60_000);
      const first = await publishDuePosts(db.pool, clock, publisher, app.deps.tokenCipher, mediaDir);
      expect(first).toEqual({ due: 1, fired: 1, missed: 0 });

      clock.advance(60_000);
      const second = await publishDuePosts(db.pool, clock, publisher, app.deps.tokenCipher, mediaDir);
      expect(second).toEqual({ due: 0, fired: 0, missed: 0 });
    });

    it("fails a due Post whose account was disconnected while it waited", async () => {
      const { auth } = await client();
      await connectPlatforms(auth, ["facebook"]);
      publisher.scriptSuccess("facebook", "never-sent");
      const composeRes = await compose(auth, {
        text: "hi",
        platforms: ["facebook"],
        scheduledAt: future(60 * 60 * 1000),
      });
      const postId = composeRes.json().post.id as string;

      // Connected when it was scheduled, unlinked before it fired. Compose's gate
      // ran an hour ago and cannot help here — the scheduler is what finds this.
      await app.inject({ method: "DELETE", url: "/api/connections/facebook", headers: auth });

      clock.advance(60 * 60 * 1000);
      const outcome = await publishDuePosts(db.pool, clock, publisher, app.deps.tokenCipher, mediaDir);

      expect(outcome).toEqual({ due: 1, fired: 1, missed: 0 });
      // Never attempted: there is no credential to attempt it with, so nothing
      // reached the Publisher at all.
      expect(publisher.sent).toHaveLength(0);

      const final = await getPost(auth, postId);
      expect(final.json().post.status).toBe("failed");
      const targets = final.json().targets as Array<{ status: string; error: string; retryCount: number }>;
      expect(targets[0]).toMatchObject({ status: "failed" });
      expect(targets[0]!.error).toMatch(/no longer connected/i);
      // Terminal on the first look — auto-retries would only re-discover the
      // same missing credential a minute later.
      expect(targets[0]!.retryCount).toBe(0);
    });
  });

  async function uploadVideo(auth: Record<string, string>): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/api/media",
      headers: { ...auth, "content-type": "video/mp4" },
      payload: Buffer.from("fake-bytes"),
    });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  }
});
