import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildTestApp } from "./helpers/app.js";
import { TestClock } from "../src/core/clock.js";
import { FakePublisher, type PageSpec } from "../src/core/fake-publisher.js";
import { startTestPostgres, type TestPostgres } from "./helpers/postgres.js";
import { publishDuePosts, GRACE_WINDOW_MS } from "../src/posts/scheduling.js";
import { retryDueTargets } from "../src/posts/retry.js";
import { RETRY_INTERVAL_MS } from "../src/posts/publish.js";
import { updatePlan } from "@smma/core";
import { provisionAndLogin } from "./helpers/provision.js";

/**
 * Slice 1 behavioral suite — publish eligibility re-checked at fire time
 * (issue #16, ADR 0011).
 *
 * The question under test is "may this Client publish to this platform *right
 * now*?", asked at the moment work fires rather than at the moment a request
 * arrived. So every test here schedules a Post while the Client is entitled,
 * changes the Plan underneath it, and then runs the tick.
 *
 * The strongest available statement is that nothing was attempted at all, so
 * the assertions are on the {@link FakePublisher}: a blocked Target must leave
 * `sent` empty, not merely end up `failed`.
 *
 * Suspension and downgrade are set up through `@smma/core` rather than the
 * Superadmin HTTP API — that API moves to its own service, and provisioning is
 * setup here, never the behavior under assertion.
 */

const NOW = new Date("2026-07-20T09:00:00.000Z");

const PAGE_WITH_IG: PageSpec = {
  id: "page-a",
  name: "Acme Storefront",
  instagram: { id: "ig-acme", username: "acme.official" },
};

type PlanToggles = { facebook: boolean; instagram: boolean; tiktok: boolean };

describe("Publish eligibility at fire time", () => {
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

  /** Provision a Client and its first User, and log that User in. */
  async function client(
    subdomain = "acme",
    plan: PlanToggles = { facebook: true, instagram: true, tiktok: true },
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

  const future = (ms: number) => new Date(clock.now().getTime() + ms).toISOString();

  const tick = () =>
    publishDuePosts(db.pool, clock, publisher, app.deps.tokenCipher, mediaDir);

  /**
   * A Post's current state read straight from the database.
   *
   * Not through `GET /api/posts/:id`, because these tests deliberately leave the
   * Client unable to make a Client-facing request at all — reading a suspended
   * Client's Post through its own API would 403 before it could tell us anything.
   */
  async function readPost(postId: string): Promise<{
    status: string;
    targets: Array<{ platform: string; status: string; error: string | null; retryCount: number }>;
  }> {
    const { rows: postRows } = await db.pool.query<{ status: string }>(
      `SELECT status FROM posts WHERE id = $1`,
      [postId],
    );
    const { rows: targetRows } = await db.pool.query<{
      platform: string;
      status: string;
      error: string | null;
      retry_count: number;
    }>(`SELECT platform, status, error, retry_count FROM targets WHERE post_id = $1`, [postId]);
    return {
      status: postRows[0]!.status,
      targets: targetRows.map((row) => ({
        platform: row.platform,
        status: row.status,
        error: row.error,
        retryCount: row.retry_count,
      })),
    };
  }

  describe("Access status", () => {
    it("publishes nothing, on any Target, for a Client suspended after the Post was scheduled", async () => {
      const { clientId, auth } = await client();
      await connectPlatforms(auth, ["facebook", "tiktok"]);
      publisher.scriptSuccess("facebook", "never-sent");
      publisher.scriptSuccess("tiktok", "never-sent-either");
      const mediaId = await uploadVideo(auth);
      const composeRes = await compose(auth, {
        text: "hi",
        media: { mediaId },
        platforms: ["facebook", "tiktok"],
        scheduledAt: future(30 * 60 * 1000),
      });
      const postId = composeRes.json().post.id as string;

      // Payment lapsed between scheduling and firing.
      await updatePlan(db.pool, clientId, { accessStatus: "suspended" });

      clock.advance(30 * 60 * 1000);
      const outcome = await tick();

      expect(outcome).toEqual({ due: 1, fired: 0, missed: 0, blocked: 1 });
      expect(publisher.sent).toHaveLength(0);
      const post = await readPost(postId);
      expect(post.status).toBe("failed");
      expect(post.targets).toHaveLength(2);
      for (const target of post.targets) {
        expect(target).toMatchObject({ status: "failed" });
        expect(target.error).toMatch(/suspend/i);
        expect(target.error).not.toMatch(/grace window/i);
      }
    });

    it("names suspension, not the grace window, on a Post that was also left late", async () => {
      const { clientId, auth } = await client();
      await connectPlatforms(auth, ["facebook"]);
      const composeRes = await compose(auth, {
        text: "hi",
        platforms: ["facebook"],
        scheduledAt: future(5 * 60 * 1000),
      });
      const postId = composeRes.json().post.id as string;

      await updatePlan(db.pool, clientId, { accessStatus: "suspended" });

      // Well past the 60-minute grace window as well as suspended. The Post
      // never had a chance to meet that window, so it must not be told it
      // missed one.
      clock.advance(5 * 60 * 1000 + GRACE_WINDOW_MS + 60_000);
      const outcome = await tick();

      // Counted as blocked, never as missed.
      expect(outcome).toEqual({ due: 1, fired: 0, missed: 0, blocked: 1 });
      expect(publisher.sent).toHaveLength(0);
      const post = await readPost(postId);
      expect(post.status).toBe("failed");
      expect(post.targets[0]!.error).toMatch(/suspend/i);
      expect(post.targets[0]!.error).not.toMatch(/grace window/i);
    });

    it("treats an expired Client exactly as a suspended one", async () => {
      const { clientId, auth } = await client();
      await connectPlatforms(auth, ["facebook"]);
      const composeRes = await compose(auth, {
        text: "hi",
        platforms: ["facebook"],
        scheduledAt: future(30 * 60 * 1000),
      });
      const postId = composeRes.json().post.id as string;

      await updatePlan(db.pool, clientId, { accessStatus: "expired" });

      clock.advance(30 * 60 * 1000);
      const outcome = await tick();

      expect(outcome).toEqual({ due: 1, fired: 0, missed: 0, blocked: 1 });
      expect(publisher.sent).toHaveLength(0);
      const post = await readPost(postId);
      expect(post.status).toBe("failed");
      expect(post.targets[0]!.error).toMatch(/expired/i);
      expect(post.targets[0]!.error).not.toMatch(/grace window/i);
    });
  });

  describe("A platform removed from the Plan", () => {
    it("fails only the Target aimed at it, and still publishes the rest", async () => {
      const { clientId, auth } = await client();
      await connectPlatforms(auth, ["facebook", "tiktok"]);
      publisher.scriptSuccess("facebook", "fb-never-sent");
      publisher.scriptSuccess("tiktok", "tt-published");
      const mediaId = await uploadVideo(auth);

      const composeRes = await compose(auth, {
        text: "Launch",
        media: { mediaId },
        platforms: ["facebook", "tiktok"],
        scheduledAt: future(30 * 60 * 1000),
      });
      const postId = composeRes.json().post.id as string;

      // Downgraded to TikTok-only after the Post was already scheduled.
      await updatePlan(db.pool, clientId, { facebook: false });

      clock.advance(30 * 60 * 1000);
      const outcome = await tick();

      // The Post itself is not blocked — its Client may still publish, just not
      // to Facebook — so the tick counts it as fired, not blocked.
      expect(outcome).toEqual({ due: 1, fired: 1, missed: 0, blocked: 0 });
      expect(publisher.sentTo("facebook")).toHaveLength(0);
      expect(publisher.sentTo("tiktok")).toHaveLength(1);

      const post = await readPost(postId);
      // Losing one platform must not cost the User the rest.
      expect(post.status).toBe("partially_published");
      const facebook = post.targets.find((t) => t.platform === "facebook")!;
      const tiktok = post.targets.find((t) => t.platform === "tiktok")!;
      expect(facebook).toMatchObject({ status: "failed" });
      expect(facebook.error).toMatch(/plan/i);
      expect(facebook.error).toMatch(/facebook/i);
      expect(tiktok).toMatchObject({ status: "published" });
    });

    it("rolls a Post up to Failed when every Target is blocked this way", async () => {
      const { clientId, auth } = await client();
      await connectPlatforms(auth, ["facebook"]);
      publisher.scriptSuccess("facebook", "never-sent");
      const composeRes = await compose(auth, {
        text: "hi",
        platforms: ["facebook"],
        scheduledAt: future(30 * 60 * 1000),
      });
      const postId = composeRes.json().post.id as string;

      await updatePlan(db.pool, clientId, { facebook: false });

      clock.advance(30 * 60 * 1000);
      await tick();

      expect(publisher.sent).toHaveLength(0);
      expect((await readPost(postId)).status).toBe("failed");
    });
  });

  describe("The auto-retry tick", () => {
    it("does not attempt a pending retry once the Client is suspended", async () => {
      const { clientId, auth } = await client();
      await connectPlatforms(auth, ["facebook"]);
      // A transient refusal, so the Target is left pending with a retry due.
      publisher.scriptFailure("facebook", "Temporarily unavailable");
      const composeRes = await compose(auth, { text: "hi", platforms: ["facebook"] });
      const postId = composeRes.json().post.id as string;
      expect(publisher.sent).toHaveLength(1);

      await updatePlan(db.pool, clientId, { accessStatus: "suspended" });

      clock.advance(RETRY_INTERVAL_MS);
      const outcome = await retryDueTargets(
        db.pool,
        clock,
        publisher,
        app.deps.tokenCipher,
        mediaDir,
      );

      // Found and settled, but nothing reached the platform a second time — and
      // a refusal is not counted as an attempt.
      expect(outcome).toMatchObject({ attempted: 0, published: 0, failed: 0, blocked: 1 });
      expect(publisher.sent).toHaveLength(1);
      const post = await readPost(postId);
      expect(post.targets[0]).toMatchObject({ status: "failed" });
      expect(post.targets[0]!.error).toMatch(/suspend/i);
    });

    it("never retries a Target that was blocked for eligibility in the first place", async () => {
      const { clientId, auth } = await client();
      await connectPlatforms(auth, ["facebook"]);
      publisher.scriptSuccess("facebook", "never-sent");
      const composeRes = await compose(auth, {
        text: "hi",
        platforms: ["facebook"],
        scheduledAt: future(30 * 60 * 1000),
      });
      const postId = composeRes.json().post.id as string;

      await updatePlan(db.pool, clientId, { facebook: false });

      clock.advance(30 * 60 * 1000);
      await tick();
      // Terminal on the first look: retrying would only re-discover the same
      // Plan a minute later.
      expect((await readPost(postId)).targets[0]).toMatchObject({
        status: "failed",
        retryCount: 0,
      });

      clock.advance(RETRY_INTERVAL_MS);
      const outcome = await retryDueTargets(
        db.pool,
        clock,
        publisher,
        app.deps.tokenCipher,
        mediaDir,
      );

      // Not even found due: a blocked Target is terminal, with no retry stamped.
      expect(outcome).toMatchObject({ attempted: 0, blocked: 0 });
      expect(publisher.sent).toHaveLength(0);
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
