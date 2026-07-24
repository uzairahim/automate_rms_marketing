import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  buildTestApp,
  TEST_BASE_DOMAIN,
  TEST_ENCRYPTION_KEY,
  TEST_SUPERADMIN_TOKEN,
} from "./helpers/app.js";
import { TestClock } from "../src/core/clock.js";
import { FakePublisher } from "../src/core/fake-publisher.js";
import { createSecretCipher } from "../src/core/crypto.js";
import { refreshDueTokens } from "../src/connections/token-refresh.js";
import { recordDailySnapshots } from "../src/analytics/snapshot-job.js";
import { publishDuePosts } from "../src/posts/scheduling.js";
import { startTestPostgres, type TestPostgres } from "./helpers/postgres.js";

/**
 * Slice 13 behavioral suite — the Meta bring-your-own-token fallback (ADR 0008)
 * and the token-expired state it requires.
 *
 * When our own app review is unavailable, a Client generates a long-lived
 * Facebook Page access token from their own Meta app and hands it to us. It goes
 * into the *same* encrypted Connected Account slot an OAuth token would occupy,
 * and is consumed identically through the Publisher seam — the whole point of the
 * abstraction (ADR 0002). Because a pasted token cannot auto-refresh, each
 * Connected Account exposes a "token expired — regenerate" state that prompts the
 * User to re-provide credentials.
 *
 * Everything is driven through the real Fastify API against a throwaway Postgres,
 * with the Publisher as the only fake — no real Meta call is ever made.
 */

const ADMIN_HOST = `admin.${TEST_BASE_DOMAIN}`;
const host = (subdomain: string) => `${subdomain}.${TEST_BASE_DOMAIN}`;
const PASSWORD = "correct horse battery";
const NOW = new Date("2026-07-24T09:00:00.000Z");

/** A long-lived Page token, exactly as a Client would paste it from Graph Explorer. */
const PASTED_TOKEN = "EAABllongLivedPageToken";

describe("Bring-your-own-token fallback (Meta)", () => {
  let db: TestPostgres;
  let app: FastifyInstance;
  let mediaDir: string;
  const clock = new TestClock(NOW);
  const publisher = new FakePublisher();
  const cipher = createSecretCipher(TEST_ENCRYPTION_KEY);

  const adminAuth = { authorization: `Bearer ${TEST_SUPERADMIN_TOKEN}` };

  beforeAll(async () => {
    db = await startTestPostgres();
    app = buildTestApp({ pool: db.pool, clock, publisher, tokenCipher: cipher });
    mediaDir = app.deps.mediaDir;
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

  /** Paste a long-lived Page token into the Facebook slot. */
  const provideToken = (
    auth: Record<string, string>,
    body: Record<string, unknown> = { token: PASTED_TOKEN, pageId: "page-a", displayName: "Acme Storefront" },
  ) =>
    app.inject({
      method: "POST",
      url: "/api/connections/facebook/token",
      headers: auth,
      payload: body,
    });

  /** The Facebook connection as GET /api/connections reports it. */
  async function facebookConnection(
    auth: Record<string, string>,
  ): Promise<{ status: string; externalId: string | null; displayName: string | null }> {
    const res = await app.inject({ method: "GET", url: "/api/connections", headers: auth });
    return (res.json().connections as Array<{ platform: string } & Record<string, string>>).find(
      (c) => c.platform === "facebook",
    ) as never;
  }

  describe("Providing a pasted token", () => {
    it("connects the Facebook Page and reports it ready to post to", async () => {
      const { clientId, auth } = await client();

      const res = await provideToken(auth);

      expect(res.statusCode).toBe(200);
      expect(res.json().connection).toMatchObject({
        platform: "facebook",
        status: "connected",
        externalId: "page-a",
        displayName: "Acme Storefront",
      });
      expect(await facebookConnection(auth)).toMatchObject({
        status: "connected",
        externalId: "page-a",
      });

      // Stored in the same slot an OAuth token uses.
      const { rows } = await db.pool.query<{ client_id: string; refreshable: boolean }>(
        "SELECT client_id, refreshable FROM connected_accounts WHERE platform = 'facebook'",
      );
      expect(rows[0]?.client_id).toBe(clientId);
    });

    it("stores the pasted token encrypted at rest (ADR 0006), never in the clear", async () => {
      const { auth } = await client();

      const res = await provideToken(auth);

      // Never echoed back to the frontend.
      expect(res.body).not.toContain(PASTED_TOKEN);

      const { rows } = await db.pool.query<{ credential: string }>(
        "SELECT credential FROM connected_accounts WHERE platform = 'facebook'",
      );
      expect(rows[0]!.credential).not.toContain(PASTED_TOKEN);
      // ...but the pasted token is what is underneath the seal.
      expect(JSON.parse(cipher.decrypt(rows[0]!.credential)).accessToken).toBe(PASTED_TOKEN);
    });

    it("marks the token non-refreshable, so the refresh job never touches it (ADR 0008)", async () => {
      const { auth } = await client();
      await provideToken(auth);

      // Even dragged into the refresh window, a hand-pasted token is skipped:
      // only a human can regenerate it.
      await db.pool.query(
        "UPDATE connected_accounts SET token_expires_at = $1 WHERE platform = 'facebook'",
        [new Date(NOW.getTime() + 60_000).toISOString()],
      );

      const outcome = await refreshDueTokens(db.pool, clock, cipher, publisher);
      expect(outcome).toEqual({ refreshed: 0, expired: 0 });
      expect(publisher.refreshed).toHaveLength(0);
    });

    it("defaults the display name to the Page id when none is given", async () => {
      const { auth } = await client();

      const res = await provideToken(auth, { token: PASTED_TOKEN, pageId: "page-z" });

      expect(res.statusCode).toBe(200);
      expect(res.json().connection).toMatchObject({ externalId: "page-z", displayName: "page-z" });
    });

    it("rejects a body missing the token or Page id", async () => {
      const { auth } = await client();

      expect((await provideToken(auth, { pageId: "page-a" })).statusCode).toBe(400);
      expect((await provideToken(auth, { token: PASTED_TOKEN })).statusCode).toBe(400);
      expect((await provideToken(auth, { token: "", pageId: "page-a" })).statusCode).toBe(400);
    });

    it("refuses a Client whose Plan does not enable Facebook", async () => {
      const { auth } = await client("globex", { tiktok: true });

      const res = await provideToken(auth);

      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("platform_not_enabled");
    });

    it("requires an authenticated session", async () => {
      await client();
      const res = await app.inject({
        method: "POST",
        url: "/api/connections/facebook/token",
        headers: { host: host("acme") },
        payload: { token: PASTED_TOKEN, pageId: "page-a" },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe("The pasted token is consumed identically to an OAuth token", () => {
    it("flows through the Publisher seam when reading account metrics", async () => {
      const { auth } = await client();
      await provideToken(auth);

      // The daily snapshot job opens the stored credential and reads through the
      // Publisher — exactly as it would for an OAuth token.
      const outcome = await recordDailySnapshots(db.pool, clock, cipher, publisher);

      expect(outcome).toMatchObject({ recorded: 1 });
      // The very token the Client pasted is what reached the transport.
      expect(publisher.accountMetricReads).toMatchObject([
        { platform: "facebook", externalId: "page-a", credential: { accessToken: PASTED_TOKEN } },
      ]);
    });

    it("lets Instagram be reached through the pasted Page token", async () => {
      const { auth } = await client();
      await provideToken(auth);
      // The Page the pasted token names links an eligible IG Business account.
      publisher.scriptPages({
        id: "page-a",
        name: "Acme Storefront",
        instagram: { id: "ig-acme", username: "acme.official" },
      });

      const res = await app.inject({
        method: "POST",
        url: "/api/connections/instagram/connect",
        headers: auth,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().connection).toMatchObject({
        platform: "instagram",
        status: "connected",
        externalId: "ig-acme",
      });
    });
  });

  describe("The token-expired state (ADR 0008: no automatic refresh)", () => {
    /** Force the Facebook slot into the token_expired state a dead pasted token lands in. */
    async function expireFacebook(): Promise<void> {
      await db.pool.query(
        "UPDATE connected_accounts SET status = 'token_expired' WHERE platform = 'facebook'",
      );
    }

    it("shows a clear token_expired state the User can act on", async () => {
      const { auth } = await client();
      await provideToken(auth);
      await expireFacebook();

      expect(await facebookConnection(auth)).toMatchObject({
        status: "token_expired",
        // The Page is still named — the User is regenerating a token for *this* Page.
        externalId: "page-a",
      });
    });

    it("blocks publishing to an expired account and surfaces the reconnect prompt", async () => {
      const { auth } = await client("acme", { facebook: true });
      await provideToken(auth);
      await expireFacebook();

      const res = await app.inject({
        method: "POST",
        url: "/api/posts",
        headers: auth,
        payload: { text: "Hello", platforms: ["facebook"] },
      });

      // Fails cleanly at the gate — the publish is never attempted.
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("platform_token_expired");
      // Distinct from platform_not_connected: it tells the User to regenerate,
      // not to connect a Page that is already linked.
      expect(res.json().message).toMatch(/regenerate|reconnect/i);
    });

    it("clears the expired state when a fresh token is provided", async () => {
      const { auth } = await client();
      await provideToken(auth);
      await expireFacebook();

      const res = await provideToken(auth, {
        token: "EAABllnewRegeneratedToken",
        pageId: "page-a",
        displayName: "Acme Storefront",
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().connection).toMatchObject({ status: "connected" });
      expect(await facebookConnection(auth)).toMatchObject({ status: "connected" });

      // Publishing works again — the gate no longer blocks it.
      const publish = await app.inject({
        method: "POST",
        url: "/api/posts",
        headers: auth,
        payload: { text: "Back in business", platforms: ["facebook"] },
      });
      expect(publish.statusCode).toBe(201);
    });
  });

  /**
   * Proactively surfacing a dead pasted token (PRD #1, the token-death-detection-lag
   * pattern). A hand-pasted token cannot auto-refresh, so the refresh job never
   * touches it; the first thing to *read* through it is the daily snapshot. That
   * job must turn a dead-token read into the `token_expired` reconnect state —
   * before a scheduled Post is the thing that discovers it by burning its retries
   * and its grace window. And a token that dies at publish time must fail its
   * Target cleanly on the first attempt, not after two doomed auto-retries.
   */
  describe("Proactive token-death detection", () => {
    it("the daily snapshot flips a dead pasted token to token_expired, before any Post needs it", async () => {
      const { auth } = await client();
      await provideToken(auth);
      // The token the Client pasted has since been invalidated on Meta's side.
      publisher.scriptAccountMetricsAuthFailure(
        "facebook",
        "Error validating access token: Session has expired.",
      );

      const outcome = await recordDailySnapshots(db.pool, clock, cipher, publisher);

      // Not merely skipped for the day: the account is moved to reconnect.
      expect(outcome).toMatchObject({ recorded: 0, expired: 1 });
      expect(await facebookConnection(auth)).toMatchObject({
        status: "token_expired",
        externalId: "page-a",
      });
    });

    it("a transient read failure only skips the day — a live account is never flipped to reconnect", async () => {
      const { auth } = await client();
      await provideToken(auth);
      // A throttle/outage, not a dead token: tomorrow's read may well succeed.
      publisher.scriptAccountMetricsFailure(
        "facebook",
        "Application request limit reached.",
      );

      const outcome = await recordDailySnapshots(db.pool, clock, cipher, publisher);

      expect(outcome).toMatchObject({ recorded: 0, skipped: 1, expired: 0 });
      expect(await facebookConnection(auth)).toMatchObject({ status: "connected" });
    });

    it("a token that dies at publish time fails the Target on the first attempt and flips the account to reconnect", async () => {
      const { auth } = await client("acme", { facebook: true });
      await provideToken(auth);
      // The gate passes (still `connected`), then the publish itself hits the dead token.
      publisher.scriptAuthFailure(
        "facebook",
        "Error validating access token: the user has not authorized application.",
      );

      const res = await app.inject({
        method: "POST",
        url: "/api/posts",
        headers: auth,
        payload: { text: "Hello", platforms: ["facebook"] },
      });

      expect(res.statusCode).toBe(201);
      const target = (res.json().targets as Array<{ platform: string } & Record<string, unknown>>).find(
        (t) => t.platform === "facebook",
      );
      // Terminal on the first attempt: no auto-retry scheduled (still `failed`,
      // retryCount 0), so the 2x1-min budget is never spent on a dead token.
      expect(target).toMatchObject({ status: "failed", retryCount: 0 });
      expect(publisher.sentTo("facebook")).toHaveLength(1);
      // And the account is now in the reconnect state the User can act on.
      expect(await facebookConnection(auth)).toMatchObject({ status: "token_expired" });
    });

    it("a Scheduled Post whose token has died fails cleanly on the first tick, not after burning the grace window", async () => {
      const { auth } = await client("acme", { facebook: true });
      await provideToken(auth);

      // Schedule a Post half an hour out.
      const scheduledAt = new Date(NOW.getTime() + 30 * 60_000).toISOString();
      const created = await app.inject({
        method: "POST",
        url: "/api/posts",
        headers: auth,
        payload: { text: "Later", platforms: ["facebook"], scheduledAt },
      });
      expect(created.statusCode).toBe(201);
      const postId = created.json().post.id as string;

      // Before it is due, the daily snapshot discovers the token is dead.
      publisher.scriptAccountMetricsAuthFailure("facebook", "Session has expired.");
      await recordDailySnapshots(db.pool, clock, cipher, publisher);
      expect(await facebookConnection(auth)).toMatchObject({ status: "token_expired" });

      // The Post comes due, well within the 60-minute grace window, and fires.
      clock.set(new Date(NOW.getTime() + 31 * 60_000));
      publisher.scriptAuthFailure("facebook", "Session has expired.");
      const outcome = await publishDuePosts(db.pool, clock, publisher, mediaDir);
      expect(outcome).toMatchObject({ due: 1, fired: 1 });

      // The Target is Failed on this first attempt — not left `pending` to burn
      // its retries and drift past the grace window before anyone notices.
      const detail = await app.inject({ method: "GET", url: `/api/posts/${postId}`, headers: auth });
      const target = (detail.json().targets as Array<{ platform: string } & Record<string, unknown>>).find(
        (t) => t.platform === "facebook",
      );
      expect(target).toMatchObject({ status: "failed", retryCount: 0 });
      expect(publisher.sentTo("facebook")).toHaveLength(1);
    });
  });
});
