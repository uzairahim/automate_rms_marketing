import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildTestApp, TEST_BASE_DOMAIN } from "./helpers/app.js";
import { provisionAndLogin } from "./helpers/provision.js";
import { TestClock } from "../src/core/clock.js";
import { FakePublisher, type PageSpec } from "../src/core/fake-publisher.js";
import { startTestPostgres, type TestPostgres } from "./helpers/postgres.js";

/**
 * Slice 11 behavioral suite — Post history, thumbnails, and per-post metrics,
 * driven through the real Fastify API against a real, throwaway Postgres.
 *
 * The platform *reads* are faked exactly as the writes are (PRD Testing
 * Decisions): the fake Publisher is scripted per platform to return a thumbnail
 * or metrics, to have none, or to refuse — so history rendering, the ephemeral
 * (re-fetched, never persisted) thumbnail contract, and live per-post metrics are
 * all deterministic with no real Meta/TikTok call.
 */

const host = (subdomain: string) => `${subdomain}.${TEST_BASE_DOMAIN}`;
const NOW = new Date("2026-07-20T09:00:00.000Z");

const PAGE_WITH_IG: PageSpec = {
  id: "page-a",
  name: "Acme Storefront",
  instagram: { id: "ig-acme", username: "acme.official" },
};
/** The Page token the connect flow seals for `page-a` (see fake-publisher's fakePage). */
const PAGE_TOKEN = "fake-page-token-page-a";

describe("Post history + thumbnails + per-post metrics", () => {
  let db: TestPostgres;
  let app: FastifyInstance;
  const clock = new TestClock(NOW);
  const publisher = new FakePublisher();

  beforeAll(async () => {
    db = await startTestPostgres();
    app = buildTestApp({ pool: db.pool, clock, publisher });
    await app.ready();
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

  const listHistory = (auth: Record<string, string>) =>
    app.inject({ method: "GET", url: "/api/posts", headers: auth });

  const getMetrics = (auth: Record<string, string>, postId: string) =>
    app.inject({ method: "GET", url: `/api/posts/${postId}/metrics`, headers: auth });

  /** Publish a text-only Facebook Post and return its id. */
  async function publishFacebook(
    auth: Record<string, string>,
    text: string,
    externalId: string,
  ): Promise<string> {
    publisher.scriptSuccess("facebook", externalId, `https://facebook.test/p/${externalId}`);
    const res = await compose(auth, { text, platforms: ["facebook"] });
    expect(res.statusCode).toBe(201);
    expect(res.json().post.status).toBe("published");
    return res.json().post.id as string;
  }

  describe("History list", () => {
    it("lists published Posts newest-first, and excludes Drafts and Scheduled Posts", async () => {
      const { auth } = await client();
      await connectPlatforms(auth, ["facebook"]);

      const firstId = await publishFacebook(auth, "First", "fb-1");
      clock.advance(1000);
      const secondId = await publishFacebook(auth, "Second", "fb-2");

      // A Draft and a Scheduled Post — neither has been published, so neither
      // belongs in history.
      await compose(auth, { text: "later", platforms: ["facebook"], draft: true });
      await compose(auth, {
        text: "soon",
        platforms: ["facebook"],
        scheduledAt: new Date(NOW.getTime() + 3_600_000).toISOString(),
      });

      const res = await listHistory(auth);
      expect(res.statusCode).toBe(200);
      const posts = res.json().posts as Array<{ id: string; text: string; status: string }>;
      expect(posts.map((p) => p.id)).toEqual([secondId, firstId]);
      expect(posts.map((p) => p.text)).toEqual(["Second", "First"]);
      for (const p of posts) expect(p.status).toBe("published");
    });

    it("shows a thumbnail fetched via the authenticated platform API using the stored post id", async () => {
      const { auth } = await client();
      await connectPlatforms(auth, ["facebook"]);
      publisher.scriptThumbnail("facebook", "https://cdn.test/thumb/fb-7.jpg");
      await publishFacebook(auth, "hi", "fb-7");

      const res = await listHistory(auth);
      const [entry] = res.json().posts as Array<{ thumbnailUrl: string | null }>;
      expect(entry?.thumbnailUrl).toBe("https://cdn.test/thumb/fb-7.jpg");

      // The read went to the platform authenticated by the *account* credential,
      // keyed by the Target's stored external id.
      expect(publisher.thumbnailReads).toHaveLength(1);
      expect(publisher.thumbnailReads[0]).toMatchObject({
        platform: "facebook",
        externalId: "fb-7",
      });
      expect(publisher.thumbnailReads[0]?.credential.accessToken).toBe(PAGE_TOKEN);
    });

    it("treats the thumbnail as ephemeral — re-fetched every request, never persisted", async () => {
      const { auth } = await client();
      await connectPlatforms(auth, ["facebook"]);
      await publishFacebook(auth, "hi", "fb-9");

      await listHistory(auth);
      await listHistory(auth);

      // Two list requests → two live reads. Nothing is cached in our DB, and the
      // targets row holds only the durable id/permalink, not a thumbnail URL.
      expect(publisher.thumbnailReads).toHaveLength(2);
      const { rows } = await db.pool.query(
        "SELECT external_id, permalink FROM targets WHERE platform = 'facebook'",
      );
      expect(rows).toEqual([
        { external_id: "fb-9", permalink: "https://facebook.test/p/fb-9" },
      ]);
    });

    it("still renders text/status when the thumbnail read is refused or rate-limited", async () => {
      const { auth } = await client();
      await connectPlatforms(auth, ["facebook"]);
      publisher.scriptThumbnailFailure("facebook", "Rate limited.");
      const postId = await publishFacebook(auth, "resilient", "fb-11");

      const res = await listHistory(auth);
      const [entry] = res.json().posts as Array<{
        id: string;
        text: string;
        status: string;
        thumbnailUrl: string | null;
      }>;
      expect(entry).toMatchObject({
        id: postId,
        text: "resilient",
        status: "published",
        thumbnailUrl: null,
      });
    });

    it("has no thumbnail for a Post whose Targets all failed, but still lists it", async () => {
      const { auth } = await client();
      await connectPlatforms(auth, ["facebook"]);
      publisher.scriptFailure("facebook", "Nope.");
      const composeRes = await compose(auth, { text: "doomed", platforms: ["facebook"] });
      const postId = composeRes.json().post.id as string;

      const res = await listHistory(auth);
      const entry = (res.json().posts as Array<{ id: string; thumbnailUrl: string | null }>).find(
        (p) => p.id === postId,
      );
      expect(entry).toBeDefined();
      expect(entry?.thumbnailUrl).toBeNull();
      // No published Target, so no thumbnail was even attempted.
      expect(publisher.thumbnailReads).toHaveLength(0);
    });

    it("uses the first readable platform's thumbnail for a multi-platform Post", async () => {
      const { auth } = await client();
      await connectPlatforms(auth, ["facebook", "instagram"]);
      publisher.scriptSuccess("facebook", "fb-a");
      publisher.scriptSuccess("instagram", "ig-a");
      // Facebook has none right now; Instagram does — the entry falls through to it.
      publisher.scriptThumbnail("facebook", null);
      publisher.scriptThumbnail("instagram", "https://cdn.test/ig-a.jpg");
      const mediaId = await uploadMedia(auth, "image/png");

      const res = await compose(auth, {
        text: "hi",
        media: { mediaId },
        platforms: ["facebook", "instagram"],
      });
      expect(res.json().post.status).toBe("published");

      const history = await listHistory(auth);
      const [entry] = history.json().posts as Array<{ thumbnailUrl: string | null }>;
      expect(entry?.thumbnailUrl).toBe("https://cdn.test/ig-a.jpg");
    });

    it("never returns another Client's Posts", async () => {
      const acme = await client("acme");
      const globex = await client("globex");
      await connectPlatforms(acme.auth, ["facebook"]);
      await publishFacebook(acme.auth, "acme only", "fb-x");

      const res = await listHistory(globex.auth);
      expect(res.json().posts).toEqual([]);
    });

    it("requires an authenticated session", async () => {
      await client();
      const res = await app.inject({
        method: "GET",
        url: "/api/posts",
        headers: { host: host("acme") },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe("Per-post metrics", () => {
    it("fetches live per-platform metrics and the permalink for each Published Target", async () => {
      const { auth } = await client();
      await connectPlatforms(auth, ["facebook", "tiktok"]);
      publisher.scriptSuccess("facebook", "fb-m", "https://facebook.test/p/fb-m");
      publisher.scriptSuccess("tiktok", "tt-m", "https://tiktok.test/v/tt-m");
      publisher.scriptMetrics("facebook", { likes: 12, comments: 3, shares: 4 });
      publisher.scriptMetrics("tiktok", { likes: 99, comments: 7, views: 5000 });
      const mediaId = await uploadMedia(auth, "video/mp4");

      const composeRes = await compose(auth, {
        text: "metrics!",
        media: { mediaId },
        platforms: ["facebook", "tiktok"],
      });
      const postId = composeRes.json().post.id as string;

      const res = await getMetrics(auth, postId);
      expect(res.statusCode).toBe(200);
      const targets = res.json().targets as Array<{
        platform: string;
        permalink: string | null;
        metrics: Record<string, number> | null;
      }>;

      const fb = targets.find((t) => t.platform === "facebook");
      expect(fb?.permalink).toBe("https://facebook.test/p/fb-m");
      expect(fb?.metrics).toEqual({ likes: 12, comments: 3, shares: 4 });

      const tt = targets.find((t) => t.platform === "tiktok");
      expect(tt?.permalink).toBe("https://tiktok.test/v/tt-m");
      expect(tt?.metrics).toEqual({ likes: 99, comments: 7, views: 5000 });

      // Live-fetched: the read is authenticated by the account credential and
      // keyed by the stored external id.
      expect(publisher.metricReads).toHaveLength(2);
      expect(publisher.metricReads.map((r) => r.externalId).sort()).toEqual(["fb-m", "tt-m"]);
    });

    it("shows one platform's metrics as unavailable without blanking the others", async () => {
      const { auth } = await client();
      await connectPlatforms(auth, ["facebook", "tiktok"]);
      publisher.scriptSuccess("facebook", "fb-ok");
      publisher.scriptSuccess("tiktok", "tt-ok");
      publisher.scriptMetrics("facebook", { likes: 5 });
      publisher.scriptMetricsFailure("tiktok", "TikTok metrics are throttled.");
      const mediaId = await uploadMedia(auth, "video/mp4");

      const composeRes = await compose(auth, {
        text: "hi",
        media: { mediaId },
        platforms: ["facebook", "tiktok"],
      });
      const postId = composeRes.json().post.id as string;

      const res = await getMetrics(auth, postId);
      const targets = res.json().targets as Array<{
        platform: string;
        metrics: Record<string, number> | null;
      }>;
      expect(targets.find((t) => t.platform === "facebook")?.metrics).toEqual({ likes: 5 });
      expect(targets.find((t) => t.platform === "tiktok")?.metrics).toBeNull();
    });

    it("reports null metrics for a Target that has not published", async () => {
      const { auth } = await client();
      await connectPlatforms(auth, ["facebook"]);
      publisher.scriptFailure("facebook", "down");
      const composeRes = await compose(auth, { text: "hi", platforms: ["facebook"] });
      const postId = composeRes.json().post.id as string;

      const res = await getMetrics(auth, postId);
      const [target] = res.json().targets as Array<{
        status: string;
        metrics: Record<string, number> | null;
      }>;
      // Pending its auto-retry — nothing published, so nothing to read.
      expect(target?.metrics).toBeNull();
      expect(publisher.metricReads).toHaveLength(0);
    });

    it("404s a Post that belongs to another Client", async () => {
      const acme = await client("acme");
      const globex = await client("globex");
      await connectPlatforms(acme.auth, ["facebook"]);
      const postId = await publishFacebook(acme.auth, "hi", "fb-p");

      const res = await getMetrics(globex.auth, postId);
      expect(res.statusCode).toBe(404);
    });
  });
});
