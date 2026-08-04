import { createHmac } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  buildTestApp,
  TEST_BASE_DOMAIN,
  TEST_ENCRYPTION_KEY,
  TEST_META_APP_SECRET,
} from "./helpers/app.js";
import { provisionAndLogin } from "./helpers/provision.js";
import { updatePlan } from "@smma/core";
import { TestClock } from "../src/core/clock.js";
import { FakePublisher, FAKE_PLATFORM_USER_ID, type PageSpec } from "../src/core/fake-publisher.js";
import { createSecretCipher } from "../src/core/crypto.js";
import { refreshDueTokens } from "../src/connections/token-refresh.js";
import { startTestPostgres, type TestPostgres } from "./helpers/postgres.js";

/**
 * Slice 7 behavioral suite — connecting Instagram and TikTok, driven through the
 * real Fastify API against a real, throwaway Postgres.
 *
 * The two platforms are here together because they are the two halves of one
 * question: what a Connected Account is when it *isn't* a Facebook Page. Instagram
 * has no OAuth of its own and is reachable only through a Page (ADR 0005); TikTok
 * has its own OAuth and no destination to choose. Both land in the same Connected
 * Account slot, refreshed by the same job, behind the same Publisher seam — so the
 * Publisher stays the only fake and no real Meta/TikTok call is ever made.
 */

const host = (subdomain: string) => `${subdomain}.${TEST_BASE_DOMAIN}`;


/** A Page with an eligible IG account linked — the happy path's starting point. */
const PAGE_WITH_IG: PageSpec = {
  id: "page-a",
  name: "Acme Storefront",
  instagram: { id: "ig-acme", username: "acme.official" },
};

describe("Connecting Instagram and TikTok", () => {
  let db: TestPostgres;
  let app: FastifyInstance;
  const clock = new TestClock(new Date("2026-07-16T09:00:00.000Z"));
  const publisher = new FakePublisher();
  const cipher = createSecretCipher(TEST_ENCRYPTION_KEY);

  beforeAll(async () => {
    db = await startTestPostgres();
    app = buildTestApp({ pool: db.pool, clock, publisher, tokenCipher: cipher });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await db.stop();
  });

  beforeEach(async () => {
    await db.pool.query(
      "TRUNCATE clients, users, sessions, connected_accounts, oauth_states RESTART IDENTITY CASCADE",
    );
    publisher.reset();
    clock.set(new Date("2026-07-16T09:00:00.000Z"));
  });

  /** Provision a Client + User with the given Plan, and log that User in. */
  async function client(
    subdomain = "acme",
    plan: Record<string, boolean> = { facebook: true, instagram: true, tiktok: true },
  ): Promise<{ clientId: string; auth: Record<string, string> }> {
    return provisionAndLogin(app, db.pool, { subdomain, plan });
  }

  /** Run the whole Facebook handshake through to a connected Page. */
  async function connectPage(auth: Record<string, string>, page: PageSpec): Promise<void> {
    publisher.scriptPages(page);
    const start = await app.inject({
      method: "POST",
      url: "/api/connections/facebook/start",
      headers: auth,
    });
    expect(start.statusCode).toBe(200);
    const state = start.json().state as string;

    const callback = await app.inject({
      method: "POST",
      url: "/api/connections/facebook/callback",
      payload: { state, code: "auth-code" },
    });
    expect(callback.statusCode).toBe(200);

    const select = await app.inject({
      method: "POST",
      url: "/api/connections/facebook/select",
      payload: { state, pageId: page.id },
    });
    expect(select.statusCode).toBe(200);
  }

  const connectInstagram = (auth: Record<string, string>) =>
    app.inject({ method: "POST", url: "/api/connections/instagram/connect", headers: auth });

  describe("Connecting Instagram (ADR 0005: only what the Page actually links to)", () => {
    it("connects the Business account linked to the connected Page", async () => {
      const { clientId, auth } = await client();
      await connectPage(auth, PAGE_WITH_IG);

      const res = await connectInstagram(auth);

      expect(res.statusCode).toBe(200);
      expect(res.json().connection).toMatchObject({
        platform: "instagram",
        status: "connected",
        externalId: "ig-acme",
        displayName: "acme.official",
      });

      const { rows } = await db.pool.query(
        `SELECT client_id, status, external_id, display_name FROM connected_accounts
         WHERE platform = 'instagram'`,
      );
      expect(rows).toEqual([
        {
          client_id: clientId,
          status: "connected",
          external_id: "ig-acme",
          display_name: "acme.official",
        },
      ]);
    });

    it("dead-ends a Page with no eligible account, with convert-to-Business guidance", async () => {
      const { auth } = await client();
      // A Page whose Instagram is personal, or linked to nothing at all, looks
      // identical from here: the Graph API simply does not name it.
      await connectPage(auth, { id: "page-a", name: "Acme Storefront" });

      const res = await connectInstagram(auth);

      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("no_instagram_account");
      // A dead-end has to say what to do about it.
      expect(res.json().message).toMatch(/business/i);

      const { rows } = await db.pool.query(
        "SELECT * FROM connected_accounts WHERE platform = 'instagram'",
      );
      expect(rows).toHaveLength(0);
    });

    it("refuses to connect Instagram before a Page is connected", async () => {
      const { auth } = await client();

      const res = await connectInstagram(auth);

      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("facebook_not_connected");
      expect(res.json().message).toMatch(/facebook page/i);
    });

    it("refuses again once the Page it was reached through is disconnected", async () => {
      const { auth } = await client();
      await connectPage(auth, PAGE_WITH_IG);
      await app.inject({
        method: "DELETE",
        url: "/api/connections/facebook",
        headers: auth,
      });

      const res = await connectInstagram(auth);

      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("facebook_not_connected");
    });

    it("tells a User with an expired Page to reconnect it, not to connect one", async () => {
      const { auth } = await client();
      await connectPage(auth, PAGE_WITH_IG);
      // The Page is still linked; its token just went bad (PRD story 26).
      await db.pool.query(
        "UPDATE connected_accounts SET status = 'token_expired' WHERE platform = 'facebook'",
      );

      const res = await connectInstagram(auth);

      expect(res.statusCode).toBe(409);
      // Distinct from facebook_not_connected: "connect a Page" would send the
      // User to fix something that isn't broken, past the Reconnect button that is.
      expect(res.json().error).toBe("facebook_token_expired");
      expect(res.json().message).toMatch(/reconnect/i);
    });

    it("publishes to Instagram with the Page's token, since Instagram has none of its own", async () => {
      const { auth } = await client();
      await connectPage(auth, PAGE_WITH_IG);
      await connectInstagram(auth);

      const { rows } = await db.pool.query<{ credential: string }>(
        "SELECT credential FROM connected_accounts WHERE platform = 'instagram'",
      );
      // Encrypted at rest like every other credential (ADR 0006)...
      expect(rows[0]!.credential).not.toContain("fake-page-token-page-a");
      // ...and it is the Page's token underneath.
      expect(JSON.parse(cipher.decrypt(rows[0]!.credential)).accessToken).toBe(
        "fake-page-token-page-a",
      );
    });

    it("never exposes the credential on a read path", async () => {
      const { auth } = await client();
      await connectPage(auth, PAGE_WITH_IG);

      const res = await connectInstagram(auth);
      expect(res.body).not.toContain("fake-page-token");
    });

    it("refuses a platform the Client's Plan does not enable", async () => {
      const { auth } = await client("globex", { facebook: true, tiktok: true });
      await connectPage(auth, PAGE_WITH_IG);

      const res = await connectInstagram(auth);

      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("platform_not_enabled");
    });

    it("requires an authenticated session", async () => {
      await client();
      const res = await app.inject({
        method: "POST",
        url: "/api/connections/instagram/connect",
        headers: { host: host("acme") },
      });
      expect(res.statusCode).toBe(401);
    });

    it("reports a refusal from Instagram as a platform error, not a crash", async () => {
      const { auth } = await client();
      await connectPage(auth, PAGE_WITH_IG);
      publisher.scriptInstagramFailure("This Page's Instagram account is unavailable.");

      const res = await connectInstagram(auth);

      expect(res.statusCode).toBe(502);
      expect(res.json().error).toBe("instagram_error");
    });
  });

  describe("One Instagram account per Client", () => {
    it("replaces the linked account when the Page's Instagram changes", async () => {
      const { auth } = await client();
      await connectPage(auth, PAGE_WITH_IG);
      await connectInstagram(auth);

      // The User relinks a different Page, carrying a different IG account.
      await connectPage(auth, {
        id: "page-b",
        name: "Acme Careers",
        instagram: { id: "ig-careers", username: "acme.careers" },
      });
      await connectInstagram(auth);

      const { rows } = await db.pool.query(
        "SELECT external_id, display_name FROM connected_accounts WHERE platform = 'instagram'",
      );
      expect(rows).toEqual([{ external_id: "ig-careers", display_name: "acme.careers" }]);
    });

    it("keeps each Client's account to itself", async () => {
      const acme = await client("acme");
      const globex = await client("globex");
      await connectPage(acme.auth, PAGE_WITH_IG);
      await connectInstagram(acme.auth);
      await connectPage(globex.auth, {
        id: "globex-page",
        name: "Globex",
        instagram: { id: "ig-globex", username: "globex" },
      });
      await connectInstagram(globex.auth);

      const seenBy = async (auth: Record<string, string>) => {
        const res = await app.inject({ method: "GET", url: "/api/connections", headers: auth });
        return (res.json().connections as Array<{ platform: string; externalId: string }>).find(
          (c) => c.platform === "instagram",
        )?.externalId;
      };
      expect(await seenBy(acme.auth)).toBe("ig-acme");
      expect(await seenBy(globex.auth)).toBe("ig-globex");
    });
  });

  describe("Connecting TikTok", () => {
    /** Begin TikTok login and return the minted state. */
    async function startTikTok(auth: Record<string, string>): Promise<string> {
      const res = await app.inject({
        method: "POST",
        url: "/api/connections/tiktok/start",
        headers: auth,
      });
      expect(res.statusCode).toBe(200);
      return res.json().state as string;
    }

    it("returns an authorize URL carrying an anti-forgery state", async () => {
      const { auth } = await client();

      const res = await app.inject({
        method: "POST",
        url: "/api/connections/tiktok/start",
        headers: auth,
      });

      expect(res.statusCode).toBe(200);
      const { authorizeUrl, state } = res.json() as { authorizeUrl: string; state: string };
      expect(state).toBeTruthy();
      expect(new URL(authorizeUrl).searchParams.get("state")).toBe(state);
    });

    it("connects the authorized account outright — there is nothing to choose", async () => {
      const { clientId, auth } = await client();
      publisher.scriptTikTokAccount({ id: "tt-acme", displayName: "Acme Official" });
      const state = await startTikTok(auth);

      const res = await app.inject({
        method: "POST",
        url: "/api/connections/tiktok/callback",
        payload: { state, code: "auth-code" },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().connection).toMatchObject({
        platform: "tiktok",
        status: "connected",
        externalId: "tt-acme",
        displayName: "Acme Official",
      });

      const { rows } = await db.pool.query(
        `SELECT client_id, status, external_id, display_name FROM connected_accounts
         WHERE platform = 'tiktok'`,
      );
      expect(rows).toEqual([
        {
          client_id: clientId,
          status: "connected",
          external_id: "tt-acme",
          display_name: "Acme Official",
        },
      ]);
    });

    it("ends the handshake once connected, so the state cannot be reused", async () => {
      const { auth } = await client();
      const state = await startTikTok(auth);

      const first = await app.inject({
        method: "POST",
        url: "/api/connections/tiktok/callback",
        payload: { state, code: "auth-code" },
      });
      expect(first.statusCode).toBe(200);

      const replay = await app.inject({
        method: "POST",
        url: "/api/connections/tiktok/callback",
        payload: { state, code: "auth-code" },
      });
      expect(replay.statusCode).toBe(400);
      expect(replay.json().error).toBe("invalid_state");

      const { rows } = await db.pool.query("SELECT * FROM oauth_states");
      expect(rows).toHaveLength(0);
    });

    it("refuses a state it never minted", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/connections/tiktok/callback",
        payload: { state: "not-a-real-state", code: "auth-code" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("invalid_state");
    });

    it("refuses a Facebook state replayed at the TikTok callback", async () => {
      const { auth } = await client();
      const fbStart = await app.inject({
        method: "POST",
        url: "/api/connections/facebook/start",
        headers: auth,
      });
      const fbState = fbStart.json().state as string;

      const res = await app.inject({
        method: "POST",
        url: "/api/connections/tiktok/callback",
        payload: { state: fbState, code: "auth-code" },
      });

      // A handshake is for the platform it was started for, and only that one.
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("invalid_state");
    });

    it("refuses to start a connection the Plan does not enable", async () => {
      const { auth } = await client("globex", { facebook: true });

      const res = await app.inject({
        method: "POST",
        url: "/api/connections/tiktok/start",
        headers: auth,
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("platform_not_enabled");
    });

    it("refuses to finish a connection disabled mid-handshake", async () => {
      const { clientId, auth } = await client();
      const state = await startTikTok(auth);

      await updatePlan(db.pool, clientId, { tiktok: false });

      const res = await app.inject({
        method: "POST",
        url: "/api/connections/tiktok/callback",
        payload: { state, code: "auth-code" },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("platform_not_enabled");
    });

    it("refuses to finish a connection for a Client suspended mid-handshake", async () => {
      const { clientId, auth } = await client();
      const state = await startTikTok(auth);

      await updatePlan(db.pool, clientId, { accessStatus: "suspended" });

      const res = await app.inject({
        method: "POST",
        url: "/api/connections/tiktok/callback",
        payload: { state, code: "auth-code" },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("client_suspended");
    });

    it("reports a rejected authorization code as a platform error, not a crash", async () => {
      const { auth } = await client();
      publisher.scriptExchangeFailure("This authorization code has expired.");
      const state = await startTikTok(auth);

      const res = await app.inject({
        method: "POST",
        url: "/api/connections/tiktok/callback",
        payload: { state, code: "stale-code" },
      });
      expect(res.statusCode).toBe(502);
      expect(res.json().error).toBe("tiktok_error");
    });

    it("connects nothing when TikTok will not say whose token it just issued", async () => {
      const { auth } = await client();
      // The exchange succeeds and the identity call does not — we hold a live
      // token for an account we cannot name, which is not a connection.
      publisher.scriptTikTokAccountFailure("This access token is not valid.");
      const state = await startTikTok(auth);

      const res = await app.inject({
        method: "POST",
        url: "/api/connections/tiktok/callback",
        payload: { state, code: "auth-code" },
      });

      expect(res.statusCode).toBe(502);
      expect(res.json().error).toBe("tiktok_error");
      const { rows } = await db.pool.query(
        "SELECT * FROM connected_accounts WHERE platform = 'tiktok'",
      );
      expect(rows).toHaveLength(0);
    });

    it("stores the TikTok token encrypted at rest (ADR 0006)", async () => {
      const { auth } = await client();
      const state = await startTikTok(auth);
      await app.inject({
        method: "POST",
        url: "/api/connections/tiktok/callback",
        payload: { state, code: "auth-code" },
      });

      const { rows } = await db.pool.query<{ credential: string }>(
        "SELECT credential FROM connected_accounts WHERE platform = 'tiktok'",
      );
      expect(rows[0]!.credential).not.toContain("fake-user-token-for-auth-code");
      expect(JSON.parse(cipher.decrypt(rows[0]!.credential)).accessToken).toBe(
        "fake-user-token-for-auth-code",
      );
    });

    it("replaces the linked account when a different one is connected", async () => {
      const { auth } = await client();
      const connect = async (account: { id: string; displayName: string }) => {
        publisher.scriptTikTokAccount(account);
        const state = await startTikTok(auth);
        const res = await app.inject({
          method: "POST",
          url: "/api/connections/tiktok/callback",
          payload: { state, code: "auth-code" },
        });
        expect(res.statusCode).toBe(200);
      };

      await connect({ id: "tt-first", displayName: "First" });
      await connect({ id: "tt-second", displayName: "Second" });

      const { rows } = await db.pool.query(
        "SELECT external_id, display_name FROM connected_accounts WHERE platform = 'tiktok'",
      );
      expect(rows).toEqual([{ external_id: "tt-second", display_name: "Second" }]);
    });
  });

  describe("Seeing and disconnecting what is connected", () => {
    /** Connect all three platforms for a Client. */
    async function connectEverything(auth: Record<string, string>): Promise<void> {
      await connectPage(auth, PAGE_WITH_IG);
      expect((await connectInstagram(auth)).statusCode).toBe(200);
      const start = await app.inject({
        method: "POST",
        url: "/api/connections/tiktok/start",
        headers: auth,
      });
      const tiktok = await app.inject({
        method: "POST",
        url: "/api/connections/tiktok/callback",
        payload: { state: start.json().state as string, code: "auth-code" },
      });
      expect(tiktok.statusCode).toBe(200);
    }

    it("reports every platform's status side by side", async () => {
      const { auth } = await client();
      await connectEverything(auth);

      const res = await app.inject({ method: "GET", url: "/api/connections", headers: auth });

      expect(res.statusCode).toBe(200);
      expect(res.json().connections).toEqual([
        {
          platform: "facebook",
          status: "connected",
          externalId: "page-a",
          displayName: "Acme Storefront",
          connectedAt: "2026-07-16T09:00:00.000Z",
        },
        {
          platform: "instagram",
          status: "connected",
          externalId: "ig-acme",
          displayName: "acme.official",
          connectedAt: "2026-07-16T09:00:00.000Z",
        },
        {
          platform: "tiktok",
          status: "connected",
          externalId: "tiktok-open-id",
          displayName: "Test TikTok",
          connectedAt: "2026-07-16T09:00:00.000Z",
        },
      ]);
    });

    it.each(["instagram", "tiktok"] as const)(
      "unlinks %s and drops its stored credential with it",
      async (platform) => {
        const { auth } = await client();
        await connectEverything(auth);

        const res = await app.inject({
          method: "DELETE",
          url: `/api/connections/${platform}`,
          headers: auth,
        });

        expect(res.statusCode).toBe(200);
        expect(res.json().connection).toMatchObject({
          platform,
          status: "disconnected",
          externalId: null,
        });
        const { rows } = await db.pool.query(
          "SELECT credential, status FROM connected_accounts WHERE platform = $1",
          [platform],
        );
        expect(rows[0]).toEqual({ credential: null, status: "disconnected" });
      },
    );

    it("leaves the other platforms connected when one is disconnected", async () => {
      const { auth } = await client();
      await connectEverything(auth);

      await app.inject({
        method: "DELETE",
        url: "/api/connections/instagram",
        headers: auth,
      });

      const res = await app.inject({ method: "GET", url: "/api/connections", headers: auth });
      const statuses = Object.fromEntries(
        (res.json().connections as Array<{ platform: string; status: string }>).map((c) => [
          c.platform,
          c.status,
        ]),
      );
      expect(statuses).toEqual({
        facebook: "connected",
        instagram: "disconnected",
        tiktok: "connected",
      });
    });

    it("refuses to disconnect a platform that is not one of ours", async () => {
      const { auth } = await client();

      const res = await app.inject({
        method: "DELETE",
        url: "/api/connections/myspace",
        headers: auth,
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe("unknown_platform");
    });
  });

  describe("Keeping Instagram and TikTok tokens alive (the refresh job covers them too)", () => {
    /**
     * The refresh job is driven directly rather than through the API — it is a
     * worker job with no HTTP surface of its own. See token-refresh.test.ts.
     */
    const runRefresh = () => refreshDueTokens(db.pool, clock, cipher, publisher);

    /** Put an account's token inside the refresh window, as the job's query sees it. */
    async function expireSoon(platform: string): Promise<void> {
      await db.pool.query(
        "UPDATE connected_accounts SET token_expires_at = $2 WHERE platform = $1",
        [platform, new Date(clock.now().getTime() + 60_000).toISOString()],
      );
    }

    it("renews an Instagram token before it expires", async () => {
      const { auth } = await client();
      await connectPage(auth, PAGE_WITH_IG);
      await connectInstagram(auth);
      await expireSoon("instagram");

      expect(await runRefresh()).toEqual({ refreshed: 1, expired: 0 });

      const { rows } = await db.pool.query<{ credential: string; status: string }>(
        "SELECT credential, status FROM connected_accounts WHERE platform = 'instagram'",
      );
      expect(rows[0]!.status).toBe("connected");
      expect(JSON.parse(cipher.decrypt(rows[0]!.credential)).accessToken).toBe(
        "fake-page-token-page-a-refreshed",
      );
    });

    it("renews a TikTok token before it expires", async () => {
      const { auth } = await client();
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
      await expireSoon("tiktok");

      expect(await runRefresh()).toEqual({ refreshed: 1, expired: 0 });

      const { rows } = await db.pool.query<{ credential: string }>(
        "SELECT credential FROM connected_accounts WHERE platform = 'tiktok'",
      );
      expect(JSON.parse(cipher.decrypt(rows[0]!.credential)).accessToken).toBe(
        "fake-user-token-for-auth-code-refreshed",
      );
    });

    it("asks the platform to renew the right destination's token", async () => {
      const { auth } = await client();
      await connectPage(auth, PAGE_WITH_IG);
      await connectInstagram(auth);
      await expireSoon("instagram");

      await runRefresh();

      // The IG account id, not the Page id: the transport is told which
      // destination this credential is for, and re-derives from there.
      expect(publisher.refreshRequests).toMatchObject([
        { platform: "instagram", externalId: "ig-acme" },
      ]);
    });

    it("marks a TikTok account token_expired when the platform refuses to renew", async () => {
      const { auth } = await client();
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
      await expireSoon("tiktok");
      // TikTok's refresh token is its own thing, so it goes bad on its own terms
      // — a creator changing their password is enough.
      publisher.scriptRefreshFailure("This refresh token has been revoked.");

      expect(await runRefresh()).toEqual({ refreshed: 0, expired: 1 });

      const res = await app.inject({ method: "GET", url: "/api/connections", headers: auth });
      expect(
        (res.json().connections as Array<{ platform: string; status: string }>).find(
          (c) => c.platform === "tiktok",
        ),
      ).toMatchObject({ status: "token_expired" });
    });

    it("marks an Instagram account token_expired when the platform refuses to renew", async () => {
      const { auth } = await client();
      await connectPage(auth, PAGE_WITH_IG);
      await connectInstagram(auth);
      await expireSoon("instagram");
      publisher.scriptRefreshFailure("This Page no longer links to that Instagram account.");

      expect(await runRefresh()).toEqual({ refreshed: 0, expired: 1 });

      const res = await app.inject({ method: "GET", url: "/api/connections", headers: auth });
      expect(
        (res.json().connections as Array<{ platform: string; status: string }>).find(
          (c) => c.platform === "instagram",
        ),
      ).toMatchObject({ status: "token_expired" });
    });
  });

  describe("When the person revokes us from Facebook (the deauthorization callback)", () => {
    it("unlinks the Instagram account along with the Page it was reached through", async () => {
      const { auth } = await client();
      await connectPage(auth, PAGE_WITH_IG);
      await connectInstagram(auth);

      // Signed exactly as Meta does — see deauthorization.test.ts for the format
      // and everything this endpoint refuses.
      const encoded = Buffer.from(
        JSON.stringify({ algorithm: "HMAC-SHA256", user_id: FAKE_PLATFORM_USER_ID }),
      ).toString("base64url");
      const signature = createHmac("sha256", TEST_META_APP_SECRET)
        .update(encoded)
        .digest("base64url");

      const res = await app.inject({
        method: "POST",
        url: "/api/webhooks/meta/deauthorize",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: `signed_request=${encodeURIComponent(`${signature}.${encoded}`)}`,
      });

      expect(res.statusCode).toBe(200);
      // Both Meta accounts are gone: the IG account publishes with the Page's
      // token, which that revocation just voided too.
      const { rows } = await db.pool.query(
        "SELECT platform, status, credential FROM connected_accounts ORDER BY platform",
      );
      expect(rows).toEqual([
        { platform: "facebook", status: "disconnected", credential: null },
        { platform: "instagram", status: "disconnected", credential: null },
      ]);
    });
  });
});
