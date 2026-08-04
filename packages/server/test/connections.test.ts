import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  buildTestApp,
  TEST_BASE_DOMAIN,
  TEST_ENCRYPTION_KEY,
} from "./helpers/app.js";
import { TestClock } from "../src/core/clock.js";
import { FakePublisher } from "../src/core/fake-publisher.js";
import { createSecretCipher } from "../src/core/crypto.js";
import { startTestPostgres, type TestPostgres } from "./helpers/postgres.js";
import { provisionAndLogin } from "./helpers/provision.js";
import { updatePlan } from "@smma/core";

/**
 * Slice 6 behavioral suite — connecting a Facebook Page as a Connected Account,
 * driven through the real Fastify API against a real, throwaway Postgres.
 *
 * The Publisher is the only fake (PRD Testing Decisions): scripting what
 * `pages_show_list` returns is how a test puts a User in the zero-Page dead-end
 * or the must-choose-between-many case, with zero real Meta calls. Every
 * assertion is on observable behavior — HTTP responses and resulting DB state.
 */

const host = (subdomain: string) => `${subdomain}.${TEST_BASE_DOMAIN}`;

describe("Connecting a Facebook Page", () => {
  let db: TestPostgres;
  let app: FastifyInstance;
  const clock = new TestClock(new Date("2026-07-16T09:00:00.000Z"));
  const publisher = new FakePublisher();
  // The same key the app is wired with, so a test can read what it stored.
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

  /** Provision a Facebook-enabled Client + User, and log in. Returns a session. */
  async function connectableClient(
    subdomain = "acme",
    plan: Record<string, boolean> = { facebook: true },
  ): Promise<{ clientId: string; token: string; auth: Record<string, string> }> {
    return provisionAndLogin(app, db.pool, { subdomain, plan });
  }

  describe("Starting Facebook login", () => {
    it("returns an authorize URL carrying an anti-forgery state", async () => {
      const { auth } = await connectableClient();

      const res = await app.inject({
        method: "POST",
        url: "/api/connections/facebook/start",
        headers: auth,
      });

      expect(res.statusCode).toBe(200);
      const { authorizeUrl, state } = res.json() as {
        authorizeUrl: string;
        state: string;
      };
      expect(state).toBeTruthy();
      // The state we're told to expect back is the one in the URL the User follows.
      expect(new URL(authorizeUrl).searchParams.get("state")).toBe(state);
    });
  });

  /** Run the start step and return the minted state. */
  async function startFacebookLogin(auth: Record<string, string>): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/api/connections/facebook/start",
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    return res.json().state as string;
  }

  describe("Returning from Facebook login (ADR 0005: the API surface enforces Pages)", () => {
    it("dead-ends a User who manages no Page, with guidance to create one", async () => {
      const { auth } = await connectableClient();
      publisher.scriptPages(); // pages_show_list returns nothing.
      const state = await startFacebookLogin(auth);

      const res = await app.inject({
        method: "POST",
        url: "/api/connections/facebook/callback",
        payload: { state, code: "auth-code" },
      });

      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("no_facebook_pages");
      // A dead-end has to say what to do about it: no Page, no connection.
      expect(res.json().message).toMatch(/business page/i);

      // Nothing was connected on the way to the dead-end.
      const { rows } = await db.pool.query("SELECT * FROM connected_accounts");
      expect(rows).toHaveLength(0);
    });

    it("offers the choice, and connects nothing, when several Pages are managed", async () => {
      const { auth } = await connectableClient();
      publisher.scriptPages(
        { id: "page-a", name: "Acme Storefront" },
        { id: "page-b", name: "Acme Careers" },
      );
      const state = await startFacebookLogin(auth);

      const res = await app.inject({
        method: "POST",
        url: "/api/connections/facebook/callback",
        payload: { state, code: "auth-code" },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().pages).toEqual([
        { id: "page-a", name: "Acme Storefront" },
        { id: "page-b", name: "Acme Careers" },
      ]);

      // The User has not chosen yet, so nothing is connected — never auto-picked.
      const { rows } = await db.pool.query("SELECT * FROM connected_accounts");
      expect(rows).toHaveLength(0);
    });

    it("offers a lone Page as a choice too, rather than taking it", async () => {
      const { auth } = await connectableClient();
      publisher.scriptPages({ id: "page-only", name: "Acme" });
      const state = await startFacebookLogin(auth);

      const res = await app.inject({
        method: "POST",
        url: "/api/connections/facebook/callback",
        payload: { state, code: "auth-code" },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().pages).toEqual([{ id: "page-only", name: "Acme" }]);
      const { rows } = await db.pool.query("SELECT * FROM connected_accounts");
      expect(rows).toHaveLength(0);
    });

    it("refuses a state it never minted", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/connections/facebook/callback",
        payload: { state: "not-a-real-state", code: "auth-code" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("invalid_state");
    });

    it("refuses a state the User took too long to come back with", async () => {
      const { auth } = await connectableClient();
      const state = await startFacebookLogin(auth);

      clock.advance(31 * 60 * 1000);

      const res = await app.inject({
        method: "POST",
        url: "/api/connections/facebook/callback",
        payload: { state, code: "auth-code" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("invalid_state");
    });
  });

  describe("Choosing which Page to connect", () => {
    /** Start + return from Facebook login, leaving a Page choice pending. */
    async function pendingChoice(
      auth: Record<string, string>,
      ...pages: Array<{ id: string; name: string }>
    ): Promise<string> {
      publisher.scriptPages(...pages);
      const state = await startFacebookLogin(auth);
      const res = await app.inject({
        method: "POST",
        url: "/api/connections/facebook/callback",
        payload: { state, code: "auth-code" },
      });
      expect(res.statusCode).toBe(200);
      return state;
    }

    it("connects the chosen Page and reports it as connected", async () => {
      const { clientId, auth } = await connectableClient();
      const state = await pendingChoice(
        auth,
        { id: "page-a", name: "Acme Storefront" },
        { id: "page-b", name: "Acme Careers" },
      );

      const res = await app.inject({
        method: "POST",
        url: "/api/connections/facebook/select",
        payload: { state, pageId: "page-b" },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().connection).toMatchObject({
        platform: "facebook",
        status: "connected",
        externalId: "page-b",
        displayName: "Acme Careers",
      });

      const { rows } = await db.pool.query(
        "SELECT client_id, platform, status, external_id, display_name FROM connected_accounts",
      );
      expect(rows).toEqual([
        {
          client_id: clientId,
          platform: "facebook",
          status: "connected",
          external_id: "page-b",
          display_name: "Acme Careers",
        },
      ]);
    });

    it("refuses a Page that was not among the ones offered", async () => {
      const { auth } = await connectableClient();
      const state = await pendingChoice(auth, { id: "page-a", name: "Acme Storefront" });

      const res = await app.inject({
        method: "POST",
        url: "/api/connections/facebook/select",
        payload: { state, pageId: "some-other-page" },
      });

      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe("page_not_found");
      const { rows } = await db.pool.query("SELECT * FROM connected_accounts");
      expect(rows).toHaveLength(0);
    });

    it("ends the handshake once a Page is chosen, so the state cannot be reused", async () => {
      const { auth } = await connectableClient();
      const state = await pendingChoice(auth, { id: "page-a", name: "Acme Storefront" });

      const first = await app.inject({
        method: "POST",
        url: "/api/connections/facebook/select",
        payload: { state, pageId: "page-a" },
      });
      expect(first.statusCode).toBe(200);

      const replay = await app.inject({
        method: "POST",
        url: "/api/connections/facebook/select",
        payload: { state, pageId: "page-a" },
      });
      expect(replay.statusCode).toBe(400);
      expect(replay.json().error).toBe("invalid_state");

      // And the user token parked mid-handshake is gone with it.
      const { rows } = await db.pool.query("SELECT * FROM oauth_states");
      expect(rows).toHaveLength(0);
    });

    it("refuses a choice before Facebook login has returned", async () => {
      const { auth } = await connectableClient();
      const state = await startFacebookLogin(auth);

      const res = await app.inject({
        method: "POST",
        url: "/api/connections/facebook/select",
        payload: { state, pageId: "page-a" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("invalid_state");
    });
  });

  /** Run the whole handshake through to a connected Page. */
  async function connectPage(
    auth: Record<string, string>,
    page: { id: string; name: string } = { id: "page-a", name: "Acme Storefront" },
  ): Promise<void> {
    publisher.scriptPages(page);
    const state = await startFacebookLogin(auth);
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

  describe("Seeing what is connected", () => {
    it("reports a platform the Client has never connected as not connected", async () => {
      const { auth } = await connectableClient();

      const res = await app.inject({
        method: "GET",
        url: "/api/connections",
        headers: auth,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().connections).toEqual([
        {
          platform: "facebook",
          status: "disconnected",
          externalId: null,
          displayName: null,
          connectedAt: null,
        },
      ]);
    });

    it("names the connected Page so the User can tell what is linked", async () => {
      const { auth } = await connectableClient();
      await connectPage(auth, { id: "page-a", name: "Acme Storefront" });

      const res = await app.inject({
        method: "GET",
        url: "/api/connections",
        headers: auth,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().connections).toEqual([
        {
          platform: "facebook",
          status: "connected",
          externalId: "page-a",
          displayName: "Acme Storefront",
          connectedAt: "2026-07-16T09:00:00.000Z",
        },
      ]);
    });

    it("reports only the platforms the Client's Plan enables", async () => {
      const { auth } = await connectableClient("globex", {
        facebook: true,
        tiktok: true,
      });

      const res = await app.inject({
        method: "GET",
        url: "/api/connections",
        headers: auth,
      });

      expect(res.statusCode).toBe(200);
      expect(
        (res.json().connections as Array<{ platform: string }>).map((c) => c.platform),
      ).toEqual(["facebook", "tiktok"]);
    });

    it("keeps showing a linked Page after the Plan stops enabling the platform", async () => {
      const { clientId, auth } = await connectableClient();
      await connectPage(auth, { id: "page-a", name: "Acme Storefront" });

      await updatePlan(db.pool, clientId, { facebook: false });

      const res = await app.inject({
        method: "GET",
        url: "/api/connections",
        headers: auth,
      });

      // A live connection is never hidden: it still holds a token, and hiding it
      // would leave the User no way to know about it or unlink it.
      expect(res.json().connections).toEqual([
        {
          platform: "facebook",
          status: "connected",
          externalId: "page-a",
          displayName: "Acme Storefront",
          connectedAt: "2026-07-16T09:00:00.000Z",
        },
      ]);
    });

    it("never exposes a credential on a read path", async () => {
      const { auth } = await connectableClient();
      await connectPage(auth);

      const res = await app.inject({
        method: "GET",
        url: "/api/connections",
        headers: auth,
      });
      expect(res.body).not.toContain("fake-page-token");
    });

    it("requires an authenticated session", async () => {
      await connectableClient();
      const res = await app.inject({
        method: "GET",
        url: "/api/connections",
        headers: { host: host("acme") },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe("One Facebook Page per Client", () => {
    it("replaces the linked Page when a different one is connected", async () => {
      const { auth } = await connectableClient();
      await connectPage(auth, { id: "page-a", name: "Acme Storefront" });
      await connectPage(auth, { id: "page-b", name: "Acme Careers" });

      const { rows } = await db.pool.query(
        "SELECT external_id, display_name, status FROM connected_accounts WHERE platform = 'facebook'",
      );
      expect(rows).toEqual([
        { external_id: "page-b", display_name: "Acme Careers", status: "connected" },
      ]);
    });

    it("keeps each Client's Page to itself", async () => {
      const acme = await connectableClient("acme");
      const globex = await connectableClient("globex");
      await connectPage(acme.auth, { id: "acme-page", name: "Acme" });
      await connectPage(globex.auth, { id: "globex-page", name: "Globex" });

      const seenBy = async (auth: Record<string, string>) => {
        const res = await app.inject({ method: "GET", url: "/api/connections", headers: auth });
        return (res.json().connections as Array<{ externalId: string }>).map((c) => c.externalId);
      };
      expect(await seenBy(acme.auth)).toEqual(["acme-page"]);
      expect(await seenBy(globex.auth)).toEqual(["globex-page"]);
    });
  });

  describe("Disconnecting", () => {
    it("unlinks the Page and drops the stored credential with it", async () => {
      const { auth } = await connectableClient();
      await connectPage(auth);

      const res = await app.inject({
        method: "DELETE",
        url: "/api/connections/facebook",
        headers: auth,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().connection).toMatchObject({
        platform: "facebook",
        status: "disconnected",
        externalId: null,
      });

      // A token we may no longer use is not kept against a possible reconnect.
      const { rows } = await db.pool.query(
        "SELECT credential, status FROM connected_accounts WHERE platform = 'facebook'",
      );
      expect(rows[0]).toEqual({ credential: null, status: "disconnected" });
    });

    it("lets a User reconnect after disconnecting", async () => {
      const { auth } = await connectableClient();
      await connectPage(auth);
      await app.inject({
        method: "DELETE",
        url: "/api/connections/facebook",
        headers: auth,
      });

      await connectPage(auth, { id: "page-again", name: "Acme Again" });

      const res = await app.inject({ method: "GET", url: "/api/connections", headers: auth });
      expect(res.json().connections[0]).toMatchObject({
        status: "connected",
        externalId: "page-again",
      });
    });

    it("is harmless when nothing is connected", async () => {
      const { auth } = await connectableClient();
      const res = await app.inject({
        method: "DELETE",
        url: "/api/connections/facebook",
        headers: auth,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().connection).toMatchObject({ status: "disconnected" });
    });

    it("can still unlink a Page after the Plan stops enabling the platform", async () => {
      const { clientId, auth } = await connectableClient();
      await connectPage(auth);

      // The Superadmin drops Facebook from the Plan. The Page stays linked, and
      // its token stays live — the Client must not be stuck with a connection it
      // can no longer see a way to remove.
      await updatePlan(db.pool, clientId, { facebook: false });

      const res = await app.inject({
        method: "DELETE",
        url: "/api/connections/facebook",
        headers: auth,
      });
      expect(res.statusCode).toBe(200);

      const { rows } = await db.pool.query(
        "SELECT credential, status FROM connected_accounts WHERE platform = 'facebook'",
      );
      expect(rows[0]).toEqual({ credential: null, status: "disconnected" });
    });
  });

  describe("Tokens are encrypted at rest (ADR 0006)", () => {
    it("stores no readable token, and can still recover it", async () => {
      const { auth } = await connectableClient();
      await connectPage(auth, { id: "page-a", name: "Acme Storefront" });

      const { rows } = await db.pool.query<{ credential: string }>(
        "SELECT credential FROM connected_accounts WHERE platform = 'facebook'",
      );
      const stored = rows[0]!.credential;

      // A database dump alone is useless: the token is not in it.
      expect(stored).not.toContain("fake-page-token-page-a");
      // ...but the key we hold decrypts it back to exactly the Page token.
      expect(JSON.parse(cipher.decrypt(stored)).accessToken).toBe("fake-page-token-page-a");
    });

    it("cannot be decrypted with a different key", async () => {
      const { auth } = await connectableClient();
      await connectPage(auth);

      const { rows } = await db.pool.query<{ credential: string }>(
        "SELECT credential FROM connected_accounts WHERE platform = 'facebook'",
      );
      const otherKey = createSecretCipher(Buffer.alloc(32, 9));
      expect(() => otherKey.decrypt(rows[0]!.credential)).toThrow();
    });
  });

  describe("Plan gating (Slice 3's gate applies to connecting)", () => {
    it("refuses to start a connection for a platform the Plan does not enable", async () => {
      const { auth } = await connectableClient("globex", { tiktok: true });

      const res = await app.inject({
        method: "POST",
        url: "/api/connections/facebook/start",
        headers: auth,
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("platform_not_enabled");
    });

    it("refuses to finish a connection disabled mid-handshake", async () => {
      const { clientId, auth } = await connectableClient();
      publisher.scriptPages({ id: "page-a", name: "Acme Storefront" });
      const state = await startFacebookLogin(auth);
      const callback = await app.inject({
        method: "POST",
        url: "/api/connections/facebook/callback",
        payload: { state, code: "auth-code" },
      });
      expect(callback.statusCode).toBe(200);

      // The Superadmin drops Facebook from the Plan while the User is choosing.
      await updatePlan(db.pool, clientId, { facebook: false });

      const res = await app.inject({
        method: "POST",
        url: "/api/connections/facebook/select",
        payload: { state, pageId: "page-a" },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("platform_not_enabled");
    });

    it("refuses to finish a connection for a Client suspended mid-handshake", async () => {
      const { clientId, auth } = await connectableClient();
      publisher.scriptPages({ id: "page-a", name: "Acme Storefront" });
      const state = await startFacebookLogin(auth);
      await app.inject({
        method: "POST",
        url: "/api/connections/facebook/callback",
        payload: { state, code: "auth-code" },
      });

      await updatePlan(db.pool, clientId, { accessStatus: "suspended" });

      const res = await app.inject({
        method: "POST",
        url: "/api/connections/facebook/select",
        payload: { state, pageId: "page-a" },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("client_suspended");
    });
  });

  describe("When Facebook itself refuses", () => {
    it("reports a rejected authorization code as a platform error, not a crash", async () => {
      const { auth } = await connectableClient();
      publisher.scriptExchangeFailure("This authorization code has expired.");
      const state = await startFacebookLogin(auth);

      const res = await app.inject({
        method: "POST",
        url: "/api/connections/facebook/callback",
        payload: { state, code: "stale-code" },
      });
      expect(res.statusCode).toBe(502);
      expect(res.json().error).toBe("facebook_error");
    });
  });
});
