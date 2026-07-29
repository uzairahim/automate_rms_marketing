import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildTestApp, TEST_BASE_DOMAIN, TEST_SUPERADMIN_TOKEN } from "./helpers/app.js";
import { TestClock } from "../src/core/clock.js";
import { FakePublisher, type PageSpec } from "../src/core/fake-publisher.js";
import { startTestPostgres, type TestPostgres } from "./helpers/postgres.js";

/**
 * The two reads/writes the composer screen needs that publishing alone did not
 * (Slice 14): listing what is still in the composer, and sending a Post that
 * already exists.
 *
 * Both exist because a Draft was otherwise write-only. `GET /api/posts` shows
 * only Posts that have left the composer, and `PATCH /api/posts/:id` refuses to
 * publish — so a Draft could be created and then never found again, let alone
 * sent.
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

describe("Drafts list + publishing an existing Post", () => {
  let db: TestPostgres;
  let app: FastifyInstance;
  const clock = new TestClock(NOW);
  const publisher = new FakePublisher();

  const adminAuth = { authorization: `Bearer ${TEST_SUPERADMIN_TOKEN}` };

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

  async function connectFacebook(auth: Record<string, string>): Promise<void> {
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

  const compose = (auth: Record<string, string>, body: Record<string, unknown>) =>
    app.inject({ method: "POST", url: "/api/posts", headers: auth, payload: body });

  const listDrafts = (auth: Record<string, string>) =>
    app.inject({ method: "GET", url: "/api/posts/drafts", headers: auth });

  const publishNow = (auth: Record<string, string>, id: string) =>
    app.inject({ method: "POST", url: `/api/posts/${id}/publish`, headers: auth });

  const getPost = (auth: Record<string, string>, id: string) =>
    app.inject({ method: "GET", url: `/api/posts/${id}`, headers: auth });

  const future = (ms: number) => new Date(clock.now().getTime() + ms).toISOString();

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

  describe("GET /api/posts/drafts", () => {
    it("lists Drafts and Scheduled Posts with the platform selection each carries", async () => {
      const { auth } = await client();
      await connectFacebook(auth);
      await compose(auth, { text: "half-written", platforms: ["facebook"], draft: true });
      await compose(auth, {
        text: "ready to go",
        platforms: ["facebook"],
        scheduledAt: future(60 * 60 * 1000),
      });

      const res = await listDrafts(auth);

      expect(res.statusCode).toBe(200);
      const posts = res.json().posts as Array<{
        text: string;
        status: string;
        targets: Array<{ platform: string; status: string }>;
      }>;
      expect(posts.map((p) => p.status)).toEqual(["scheduled", "draft"]);
      // A Draft's Targets exist from creation — they have just never been tried.
      expect(posts.every((p) => p.targets.every((t) => t.status === "pending"))).toBe(true);
      expect(posts[1]!.targets.map((t) => t.platform)).toEqual(["facebook"]);
    });

    it("orders Scheduled Posts soonest-first, ahead of undated Drafts", async () => {
      const { auth } = await client();
      await connectFacebook(auth);
      await compose(auth, { text: "a draft", platforms: [], draft: true });
      await compose(auth, {
        text: "later",
        platforms: ["facebook"],
        scheduledAt: future(5 * 60 * 60 * 1000),
      });
      await compose(auth, {
        text: "sooner",
        platforms: ["facebook"],
        scheduledAt: future(60 * 60 * 1000),
      });

      const posts = (await listDrafts(auth)).json().posts as Array<{ text: string }>;

      expect(posts.map((p) => p.text)).toEqual(["sooner", "later", "a draft"]);
    });

    it("excludes a Post that has already published — that is history's job", async () => {
      const { auth } = await client();
      await connectFacebook(auth);
      publisher.scriptSuccess("facebook", "fb-1");
      await compose(auth, { text: "sent", platforms: ["facebook"] });
      await compose(auth, { text: "unsent", platforms: [], draft: true });

      const posts = (await listDrafts(auth)).json().posts as Array<{ text: string }>;

      expect(posts.map((p) => p.text)).toEqual(["unsent"]);
    });

    it("never shows one Client's Drafts to another", async () => {
      const acme = await client("acme");
      const globex = await client("globex");
      await compose(acme.auth, { text: "acme secret", platforms: [], draft: true });

      const posts = (await listDrafts(globex.auth)).json().posts as unknown[];

      expect(posts).toEqual([]);
    });

    it("carries the attached Media's id, so an edit can re-send it", async () => {
      const { auth } = await client();
      const mediaId = await uploadVideo(auth);
      await compose(auth, { text: "with video", media: { mediaId }, platforms: [], draft: true });

      const posts = (await listDrafts(auth)).json().posts as Array<{
        mediaId: string;
        media: { type: string };
      }>;

      expect(posts[0]!.mediaId).toBe(mediaId);
      expect(posts[0]!.media.type).toBe("video");
    });
  });

  describe("POST /api/posts/:id/publish", () => {
    it("sends a Draft now, through the same fan-out an immediate compose uses", async () => {
      const { auth } = await client();
      await connectFacebook(auth);
      publisher.scriptSuccess("facebook", "fb-from-draft", "https://facebook.test/p/9");
      const draft = await compose(auth, {
        text: "finished yesterday's draft",
        platforms: ["facebook"],
        draft: true,
      });
      const postId = draft.json().post.id as string;

      const res = await publishNow(auth, postId);

      expect(res.statusCode).toBe(200);
      expect(res.json().post.status).toBe("published");
      expect(res.json().targets[0]).toMatchObject({
        platform: "facebook",
        status: "published",
        externalId: "fb-from-draft",
        permalink: "https://facebook.test/p/9",
      });
      expect(publisher.sentTo("facebook")).toMatchObject([{ text: "finished yesterday's draft" }]);
    });

    it("sends a Scheduled Post early, and clears the schedule it no longer has", async () => {
      const { auth } = await client();
      await connectFacebook(auth);
      publisher.scriptSuccess("facebook", "fb-early");
      const scheduled = await compose(auth, {
        text: "why wait",
        platforms: ["facebook"],
        scheduledAt: future(3 * 60 * 60 * 1000),
      });
      const postId = scheduled.json().post.id as string;

      const res = await publishNow(auth, postId);

      expect(res.statusCode).toBe(200);
      expect(res.json().post.status).toBe("published");
      expect(res.json().post.scheduledAt).toBeNull();
    });

    it("applies the same content gate — a TikTok Draft with no video is refused", async () => {
      const { auth } = await client();
      // Connected, so the refusal can only be about the content itself.
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
      const draft = await compose(auth, { text: "no video", platforms: ["tiktok"], draft: true });
      const postId = draft.json().post.id as string;

      const res = await publishNow(auth, postId);

      expect(res.statusCode).toBe(422);
      expect(res.json().error).toBe("invalid_content");
      expect(res.json().reasons.tiktok).toMatch(/video/i);
      expect(publisher.sent).toHaveLength(0);
      // Refused, not consumed: the Draft is still a Draft to go back and fix.
      expect((await getPost(auth, postId)).json().post.status).toBe("draft");
    });

    it("refuses a Draft targeting a platform with nothing connected", async () => {
      const { auth } = await client();
      const draft = await compose(auth, { text: "hi", platforms: ["facebook"], draft: true });

      const res = await publishNow(auth, draft.json().post.id as string);

      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("platform_not_connected");
      expect(publisher.sent).toHaveLength(0);
    });

    it("refuses a Draft with no platform selected at all", async () => {
      const { auth } = await client();
      const draft = await compose(auth, { text: "hi", platforms: [], draft: true });

      const res = await publishNow(auth, draft.json().post.id as string);

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("no_platforms_selected");
    });

    it("refuses a Draft whose Media was purged, rather than publishing a dead URL", async () => {
      const { auth } = await client();
      await connectFacebook(auth);
      const mediaId = await uploadVideo(auth);
      const draft = await compose(auth, {
        text: "stale attachment",
        media: { mediaId },
        platforms: ["facebook"],
        draft: true,
      });
      await db.pool.query("UPDATE media SET status = 'purged' WHERE id = $1", [mediaId]);

      const res = await publishNow(auth, draft.json().post.id as string);

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("invalid_media");
      expect(publisher.sent).toHaveLength(0);
    });

    it("refuses a Post that has already left the composer", async () => {
      const { auth } = await client();
      await connectFacebook(auth);
      publisher.scriptSuccess("facebook", "fb-1");
      const sent = await compose(auth, { text: "already gone", platforms: ["facebook"] });

      const res = await publishNow(auth, sent.json().post.id as string);

      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("not_publishable");
      // Not re-sent: the one publish it already had is the only one.
      expect(publisher.sentTo("facebook")).toHaveLength(1);
    });

    it("404s publishing a Post belonging to another Client", async () => {
      const acme = await client("acme");
      const globex = await client("globex");
      const draft = await compose(acme.auth, { text: "acme's", platforms: [], draft: true });

      const res = await publishNow(globex.auth, draft.json().post.id as string);

      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe("post_not_found");
    });
  });
});
