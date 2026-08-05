import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance, InjectOptions } from "fastify";
import { createUser } from "@smma/core";
import { buildTestAdminApp, loginAs } from "./helpers/app.js";
import { startTestPostgres, type TestPostgres } from "./helpers/postgres.js";
import { buildTestClientApp, clientHost } from "./helpers/client-app.js";
import { connectPlatforms, schedulePost, type ClientAuth } from "./helpers/scheduled-posts.js";
import { TestClock } from "../src/clock.js";
import { upsertSuperadmin } from "../src/auth/superadmins.js";
// Development-only, as above: the enforcement this slice exists to make visible
// happens inside the Client-facing service's ticks, so the only honest way to
// show that suspending from the panel suspends is to run them.
import { FakePublisher } from "../../server/src/core/fake-publisher.js";
import { publishDuePosts } from "../../server/src/posts/scheduling.js";
import { retryDueTargets } from "../../server/src/posts/retry.js";
import { RETRY_INTERVAL_MS } from "../../server/src/posts/publish.js";

/**
 * The operator's actual levers: which platforms a Client may use, whether it may
 * act at all, and what the panel says before either change is committed.
 *
 * Two things are under test here, and they are deliberately not the same thing.
 * The previews are a *courtesy*: numbers shown so the operator knows what they
 * are about to break. The enforcement is the invariant, and it holds whether or
 * not anyone read them — so the suspension tests never touch a preview, and
 * assert instead on the {@link FakePublisher} that nothing was sent at all.
 *
 * Everything is driven through the panel's own API, because "suspending from the
 * panel actually suspends" is the claim; changing `access_status` in SQL and
 * then observing the scheduler would prove a different, weaker one.
 */

const EMAIL = "operator@ourapp.test";
const PASSWORD = "correct horse battery";
const USER_EMAIL = "user@acme.test";
const USER_PASSWORD = "their own password";
const NOW = new Date("2026-08-04T09:00:00.000Z");
const HALF_HOUR = 30 * 60 * 1000;

describe("A Client's Plan in the admin panel", () => {
  let db: TestPostgres;
  let app: FastifyInstance;
  let clientApp: FastifyInstance;
  let cookies: InjectOptions["cookies"];
  const clock = new TestClock(NOW);
  const publisher = new FakePublisher();

  beforeAll(async () => {
    db = await startTestPostgres({ clientSchema: true });
    app = buildTestAdminApp({ pool: db.pool, clock });
    clientApp = buildTestClientApp({ pool: db.pool, clock, publisher });
    await Promise.all([app.ready(), clientApp.ready()]);
  });

  afterAll(async () => {
    await Promise.all([app.close(), clientApp.close()]);
    await db.stop();
  });

  beforeEach(async () => {
    clock.set(NOW);
    publisher.reset();
    await db.pool.query("TRUNCATE superadmins, admin_sessions RESTART IDENTITY CASCADE");
    await db.pool.query(
      "TRUNCATE clients, users, sessions, connected_accounts, oauth_states, posts, media RESTART IDENTITY CASCADE",
    );
    await upsertSuperadmin(db.pool, { email: EMAIL, password: PASSWORD });
    ({ cookies } = await loginAs(app, { email: EMAIL, password: PASSWORD }));
  });

  /* ------------------------------------------------------------ the panel */

  const provision = (body: Record<string, unknown>) =>
    app.inject({ method: "POST", url: "/api/clients", payload: body, cookies });

  const patchPlan = (clientId: string, body: Record<string, unknown>) =>
    app.inject({
      method: "PATCH",
      url: `/api/clients/${clientId}/plan`,
      payload: body,
      cookies,
    });

  const previewCounts = (clientId: string) =>
    app.inject({
      method: "GET",
      url: `/api/clients/${clientId}/scheduled-post-counts`,
      cookies,
    });

  /** Provision a Client through the panel, with every platform enabled. */
  async function client(
    subdomain = "acme",
    plan: Record<string, boolean> = { facebook: true, instagram: true, tiktok: true },
  ): Promise<string> {
    const res = await provision({ subdomain, timezone: "America/New_York", plan });
    if (res.statusCode !== 201) throw new Error(`Provisioning failed: ${res.body}`);
    return res.json().client.id as string;
  }

  /* ---------------------------------------------------- the Client's side */

  const clientLogin = (subdomain: string, email = USER_EMAIL, password = USER_PASSWORD) =>
    clientApp.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { host: clientHost(subdomain) },
      payload: { email, password },
    });

  /** Add a User to a Client and log them in on their own subdomain. */
  async function userOf(clientId: string, subdomain: string): Promise<ClientAuth> {
    await createUser(db.pool, {
      clientId,
      email: USER_EMAIL,
      password: USER_PASSWORD,
    });
    const res = await clientLogin(subdomain);
    if (res.statusCode !== 200) throw new Error(`Login failed: ${res.body}`);
    return {
      host: clientHost(subdomain),
      authorization: `Bearer ${res.json().token as string}`,
    };
  }

  const future = (ms: number) => new Date(clock.now().getTime() + ms);

  const tick = () =>
    publishDuePosts(db.pool, clock, publisher, clientApp.deps.tokenCipher, clientApp.deps.mediaDir);

  const retryTick = () =>
    retryDueTargets(db.pool, clock, publisher, clientApp.deps.tokenCipher, clientApp.deps.mediaDir);

  /**
   * A Post's Targets read straight from the database.
   *
   * Not through the Client-facing API: these tests deliberately leave the Client
   * unable to make a request at all, so its own read would 403 before it could
   * say anything about the Post.
   */
  async function targetsOf(postId: string): Promise<Array<{ status: string; error: string | null }>> {
    const { rows } = await db.pool.query<{ status: string; error: string | null }>(
      `SELECT status, error FROM targets WHERE post_id = $1 ORDER BY platform`,
      [postId],
    );
    return rows;
  }

  /* ------------------------------------------------------ Platform toggles */

  describe("Platform toggles", () => {
    it("turns a platform off after creation, and the Client's SPA stops offering it", async () => {
      const clientId = await client();
      const auth = await userOf(clientId, "acme");

      // Live on the Client's own surface before the change.
      const before = await clientApp.inject({ method: "GET", url: "/api/platforms", headers: auth });
      expect(before.json().platforms).toEqual(["facebook", "instagram", "tiktok"]);

      const res = await patchPlan(clientId, { facebook: false });

      expect(res.statusCode).toBe(200);
      expect(res.json().plan).toEqual({
        facebook: false,
        instagram: true,
        tiktok: true,
        accessStatus: "active",
      });

      const after = await clientApp.inject({ method: "GET", url: "/api/platforms", headers: auth });
      expect(after.json().platforms).toEqual(["instagram", "tiktok"]);
      // And acting on it is refused, not merely hidden.
      const acting = await clientApp.inject({
        method: "GET",
        url: "/api/platforms/facebook",
        headers: auth,
      });
      expect(acting.statusCode).toBe(403);
    });

    it("turns a platform back on, so a Client can be upgraded as well as downgraded", async () => {
      const clientId = await client("acme", { facebook: false, instagram: false, tiktok: false });
      const auth = await userOf(clientId, "acme");

      await patchPlan(clientId, { instagram: true });

      const res = await clientApp.inject({ method: "GET", url: "/api/platforms", headers: auth });
      expect(res.json().platforms).toEqual(["instagram"]);
    });

    it("leaves the toggles it was not given alone", async () => {
      const clientId = await client("acme", { facebook: true, instagram: false, tiktok: true });

      const res = await patchPlan(clientId, { instagram: true });

      expect(res.json().plan).toMatchObject({ facebook: true, instagram: true, tiktok: true });
    });

    it("rejects a toggle that is not a boolean", async () => {
      const clientId = await client();

      const res = await patchPlan(clientId, { facebook: "yes" });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("invalid_plan");
      // Nothing half-applied.
      const { rows } = await db.pool.query("SELECT facebook_enabled FROM clients");
      expect(rows[0].facebook_enabled).toBe(true);
    });
  });

  /* -------------------------------------------------------- Access status */

  describe("Access status", () => {
    it("suspends, expires, and restores a Client", async () => {
      const clientId = await client();

      for (const accessStatus of ["suspended", "expired", "active"] as const) {
        const res = await patchPlan(clientId, { accessStatus });
        expect(res.statusCode).toBe(200);
        expect(res.json().plan).toMatchObject({ accessStatus });
      }
    });

    it("deletes nothing when a Client is suspended", async () => {
      const clientId = await client();
      const auth = await userOf(clientId, "acme");
      await connectPlatforms(clientApp, publisher, auth, ["facebook"]);
      const postId = await schedulePost(clientApp, auth, {
        platforms: ["facebook"],
        scheduledAt: future(HALF_HOUR),
      });

      await patchPlan(clientId, { accessStatus: "suspended" });

      // Suspension exists so that access can be blocked *without* deleting
      // anything (PRD #1) — the Client, its User, and its Post all survive it.
      const { rows } = await db.pool.query(
        `SELECT (SELECT count(*) FROM clients) AS clients,
                (SELECT count(*) FROM users) AS users,
                (SELECT count(*) FROM posts WHERE id = $1) AS posts`,
        [postId],
      );
      expect(rows[0]).toEqual({ clients: "1", users: "1", posts: "1" });
    });

    it("rejects an access status that is not one of the three", async () => {
      const clientId = await client();

      const res = await patchPlan(clientId, { accessStatus: "cancelled" });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("invalid_access_status");
    });

    it("refuses a patch that names nothing, rather than silently doing nothing", async () => {
      const clientId = await client();

      const res = await patchPlan(clientId, { facebok: true });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("invalid_body");
    });

    it("answers 404 for a Client that does not exist", async () => {
      const res = await patchPlan("00000000-0000-0000-0000-000000000000", {
        accessStatus: "suspended",
      });

      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe("client_not_found");
    });
  });

  /* --------------------------------------------------- Consequence previews */

  describe("Consequence previews", () => {
    it("counts a Client's Scheduled Posts, overall and by the platforms they target", async () => {
      const clientId = await client();
      const auth = await userOf(clientId, "acme");
      await connectPlatforms(clientApp, publisher, auth, ["facebook", "instagram", "tiktok"]);

      // Real Posts through the Client-facing service's own compose and
      // scheduling logic — a count asserted against hand-written SQL would be a
      // count of rows this platform might never produce.
      await schedulePost(clientApp, auth, {
        platforms: ["facebook", "instagram"],
        scheduledAt: future(HALF_HOUR),
      });
      await schedulePost(clientApp, auth, {
        platforms: ["facebook"],
        scheduledAt: future(2 * HALF_HOUR),
      });
      await schedulePost(clientApp, auth, {
        platforms: ["tiktok"],
        scheduledAt: future(3 * HALF_HOUR),
      });

      const res = await previewCounts(clientId);

      expect(res.statusCode).toBe(200);
      expect(res.json().counts).toEqual({
        total: 3,
        byPlatform: { facebook: 2, instagram: 1, tiktok: 1 },
      });
    });

    it("counts only what is still scheduled — not a Draft, and not one already fired", async () => {
      const clientId = await client();
      const auth = await userOf(clientId, "acme");
      await connectPlatforms(clientApp, publisher, auth, ["facebook"]);
      publisher.scriptSuccess("facebook", "fb-1");

      // Fired: due, published, and therefore no longer anything a downgrade
      // could break.
      await schedulePost(clientApp, auth, {
        platforms: ["facebook"],
        scheduledAt: future(HALF_HOUR),
      });
      clock.advance(HALF_HOUR);
      expect(await tick()).toMatchObject({ fired: 1 });

      // A Draft carries no obligation and no schedule to break.
      await clientApp.inject({
        method: "POST",
        url: "/api/posts",
        headers: auth,
        payload: { text: "later", platforms: ["facebook"], draft: true },
      });

      // Still scheduled.
      await schedulePost(clientApp, auth, {
        platforms: ["facebook"],
        scheduledAt: future(HALF_HOUR),
      });

      const res = await previewCounts(clientId);

      expect(res.json().counts).toEqual({
        total: 1,
        byPlatform: { facebook: 1, instagram: 0, tiktok: 0 },
      });
    });

    it("counts only this Client's Posts", async () => {
      const mine = await client("acme");
      const theirs = await client("globex");
      const myAuth = await userOf(mine, "acme");
      await connectPlatforms(clientApp, publisher, myAuth, ["facebook"]);
      await schedulePost(clientApp, myAuth, {
        platforms: ["facebook"],
        scheduledAt: future(HALF_HOUR),
      });

      expect((await previewCounts(mine)).json().counts.total).toBe(1);
      expect((await previewCounts(theirs)).json().counts).toEqual({
        total: 0,
        byPlatform: { facebook: 0, instagram: 0, tiktok: 0 },
      });
    });

    /**
     * The API half of "both confirmations can be cancelled, leaving the Client
     * unchanged": the preview is a read, so *cancelling is simply never sending
     * the patch*, and there is no half-committed state for it to leave behind.
     *
     * The panel's Cancel button itself is not covered here. This repo has no
     * DOM-rendering test seam, and PRD #15 was explicit that this work adds no
     * new *kinds* of seam — so that half is the manual step in the `verify`
     * skill, and this is the part that can be proven.
     */
    it("leaves the Client untouched however many times it is asked", async () => {
      const clientId = await client();
      const auth = await userOf(clientId, "acme");
      await connectPlatforms(clientApp, publisher, auth, ["facebook"]);
      await schedulePost(clientApp, auth, {
        platforms: ["facebook"],
        scheduledAt: future(HALF_HOUR),
      });

      expect((await previewCounts(clientId)).json().counts.total).toBe(1);

      const after = await app.inject({ method: "GET", url: `/api/clients/${clientId}`, cookies });
      expect(after.json().client.plan).toEqual({
        facebook: true,
        instagram: true,
        tiktok: true,
        accessStatus: "active",
      });
      // And the Post it warned about is still there to be warned about again.
      expect((await previewCounts(clientId)).json().counts.total).toBe(1);
    });

    it("answers 404 for a Client that does not exist", async () => {
      const res = await previewCounts("00000000-0000-0000-0000-000000000000");

      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe("client_not_found");
    });
  });

  /* ------------------------------------------- Suspension, end to end */

  describe("Suspending a Client from the panel", () => {
    /** A Client with a live User and a connected platform, publishing normally. */
    async function liveClient(subdomain = "acme") {
      const clientId = await client(subdomain);
      const auth = await userOf(clientId, subdomain);
      await connectPlatforms(clientApp, publisher, auth, ["facebook"]);
      publisher.scriptSuccess("facebook", "must-not-be-sent");
      return { clientId, auth, subdomain };
    }

    /**
     * That, plus one Scheduled Post half an hour out — everything suspension has
     * to stop, in place before it is suspended.
     */
    async function readyToPublish(subdomain = "acme") {
      const live = await liveClient(subdomain);
      const postId = await schedulePost(clientApp, live.auth, {
        platforms: ["facebook"],
        scheduledAt: future(HALF_HOUR),
      });
      return { ...live, postId };
    }

    /**
     * Leave this Client holding a Target that failed with an auto-retry already
     * due — the state the *other* path into the publishing domain picks up.
     *
     * Built by firing a Post while the Client is entitled and letting the
     * platform turn it down, because that is the only way this state legitimately
     * arises. The Client is put back to active first, so the same helper serves
     * whichever non-active status the caller is about to set.
     */
    async function pendingRetryFor(clientId: string, auth: ClientAuth): Promise<string> {
      await patchPlan(clientId, { accessStatus: "active" });
      const postId = await schedulePost(clientApp, auth, {
        platforms: ["facebook"],
        scheduledAt: future(HALF_HOUR),
      });

      publisher.scriptFailure("facebook", "temporary platform error");
      clock.advance(HALF_HOUR);
      await tick();

      // Pending, not failed: the auto-retry budget is still unspent, which is
      // exactly what the next tick must decline to use.
      expect((await targetsOf(postId))[0]!.status).toBe("pending");
      return postId;
    }

    it("locks its Users out, naming suspension", async () => {
      const { clientId } = await readyToPublish();

      await patchPlan(clientId, { accessStatus: "suspended" });

      const res = await clientLogin("acme");
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("client_suspended");
      expect(res.json().message).toMatch(/suspend/i);
    });

    it("blocks a User who is already holding a live session", async () => {
      const { clientId, auth } = await readyToPublish();
      // Working right up to the moment the operator acts.
      expect((await clientApp.inject({ method: "GET", url: "/api/me", headers: auth })).statusCode).toBe(200);

      await patchPlan(clientId, { accessStatus: "suspended" });

      const res = await clientApp.inject({ method: "GET", url: "/api/me", headers: auth });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("client_suspended");
    });

    it("stops its Scheduled Posts from publishing", async () => {
      const { clientId, postId } = await readyToPublish();

      await patchPlan(clientId, { accessStatus: "suspended" });

      clock.advance(HALF_HOUR);
      const outcome = await tick();

      expect(outcome).toMatchObject({ due: 1, fired: 0, blocked: 1 });
      // The strongest available statement: nothing was attempted at all.
      expect(publisher.sent).toHaveLength(0);
      const targets = await targetsOf(postId);
      expect(targets).toHaveLength(1);
      expect(targets[0]!.status).toBe("failed");
      expect(targets[0]!.error).toMatch(/suspend/i);
      expect(targets[0]!.error).not.toMatch(/grace window/i);
    });

    it("stops its failed Targets from being retried", async () => {
      // No pre-scheduled Post here: the retry tick must find exactly the one
      // pending Target this test is about, so its count means something.
      const { clientId, auth } = await liveClient();
      const postId = await pendingRetryFor(clientId, auth);

      await patchPlan(clientId, { accessStatus: "suspended" });

      publisher.reset();
      clock.advance(RETRY_INTERVAL_MS);
      const outcome = await retryTick();

      expect(outcome).toMatchObject({ attempted: 0, blocked: 1 });
      expect(publisher.sent).toHaveLength(0);
      const targets = await targetsOf(postId);
      expect(targets[0]!.status).toBe("failed");
      expect(targets[0]!.error).toMatch(/suspend/i);
    });

    // Every one of the four things suspension stops, repeated for `expired`.
    // There must be no gap between the two non-active statuses, so the check is
    // deliberately the whole list rather than a sample of it.
    it("treats an expired Client exactly as a suspended one, throughout", async () => {
      const { clientId, auth } = await readyToPublish();

      await patchPlan(clientId, { accessStatus: "expired" });

      // 1. Locked out at the door, and told why.
      const login = await clientLogin("acme");
      expect(login.statusCode).toBe(403);
      expect(login.json().error).toBe("client_expired");
      expect(login.json().message).toMatch(/expired/i);

      // 2. And mid-session, without waiting for a token to lapse.
      const live = await clientApp.inject({ method: "GET", url: "/api/me", headers: auth });
      expect(live.statusCode).toBe(403);
      expect(live.json().error).toBe("client_expired");

      // 3. Scheduled Posts do not publish.
      clock.advance(HALF_HOUR);
      expect(await tick()).toMatchObject({ due: 1, fired: 0, blocked: 1 });
      expect(publisher.sent).toHaveLength(0);

      // 4. And a Target left pending from before the lapse is not retried.
      const pendingPostId = await pendingRetryFor(clientId, auth);
      await patchPlan(clientId, { accessStatus: "expired" });
      publisher.reset();
      clock.advance(RETRY_INTERVAL_MS);
      expect(await retryTick()).toMatchObject({ attempted: 0, blocked: 1 });
      expect(publisher.sent).toHaveLength(0);
      const retried = await targetsOf(pendingPostId);
      expect(retried[0]!.status).toBe("failed");
      expect(retried[0]!.error).toMatch(/expired/i);
    });

    it("restores an expired Client just as it restores a suspended one", async () => {
      const { clientId, postId } = await readyToPublish();

      await patchPlan(clientId, { accessStatus: "expired" });
      await patchPlan(clientId, { accessStatus: "active" });

      expect((await clientLogin("acme")).statusCode).toBe(200);
      clock.advance(HALF_HOUR);
      expect(await tick()).toMatchObject({ fired: 1, blocked: 0 });
      expect((await targetsOf(postId))[0]!.status).toBe("published");
    });

    it("restores both login and publishing when set back to active", async () => {
      const { clientId, postId } = await readyToPublish();

      await patchPlan(clientId, { accessStatus: "suspended" });
      await patchPlan(clientId, { accessStatus: "active" });

      // Logging in again works — the old session was not revoked, but a Client
      // whose access lapsed will have been signed out by the 403 above.
      const login = await clientLogin("acme");
      expect(login.statusCode).toBe(200);

      clock.advance(HALF_HOUR);
      const outcome = await tick();

      expect(outcome).toMatchObject({ due: 1, fired: 1, blocked: 0 });
      expect(publisher.sentTo("facebook")).toHaveLength(1);
      expect((await targetsOf(postId))[0]!.status).toBe("published");
    });
  });

  /* --------------------------------------------------------- The front door */

  describe("Authentication", () => {
    it("rejects every one of these routes for a request with no session", async () => {
      const clientId = await client();

      const unauthenticated = await Promise.all([
        app.inject({
          method: "PATCH",
          url: `/api/clients/${clientId}/plan`,
          payload: { accessStatus: "suspended" },
        }),
        app.inject({ method: "GET", url: `/api/clients/${clientId}/scheduled-post-counts` }),
      ]);

      for (const res of unauthenticated) {
        expect(res.statusCode).toBe(401);
        expect(res.json()).toEqual({ error: "unauthorized" });
      }

      // And the Client the unauthenticated caller aimed at is untouched.
      const { rows } = await db.pool.query("SELECT access_status FROM clients");
      expect(rows[0].access_status).toBe("active");
    });
  });
});
