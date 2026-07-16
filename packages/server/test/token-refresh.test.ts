import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type pg from "pg";
import { TestClock } from "../src/core/clock.js";
import { FakePublisher } from "../src/core/fake-publisher.js";
import { createSecretCipher } from "../src/core/crypto.js";
import { openCredential } from "../src/connections/credentials.js";
import { connectAccount, disconnectAccount, findAccount } from "../src/connections/accounts.js";
import { refreshDueTokens, REFRESH_WINDOW_MS } from "../src/connections/token-refresh.js";
import { startTestPostgres, type TestPostgres } from "./helpers/postgres.js";

/**
 * Slice 6 — the token-refresh job. A Page token that quietly expires means a
 * Client's Posts start failing for reasons the User cannot see, so the job's
 * whole job is to renew tokens *before* that happens.
 *
 * The job is exercised directly rather than through BullMQ: the recurring
 * trigger is Redis's business, but "which accounts are due, and what happens to
 * each" is ours. With the Clock injected (PRD Testing Decisions), a token
 * expiring in six days is a fact a test can just state.
 */

const NOW = new Date("2026-07-16T09:00:00.000Z");
const hours = (n: number) => n * 60 * 60 * 1000;
const days = (n: number) => hours(24 * n);

describe("Token refresh job", () => {
  let db: TestPostgres;
  let pool: pg.Pool;
  const clock = new TestClock(NOW);
  const publisher = new FakePublisher();
  const cipher = createSecretCipher(Buffer.alloc(32, 7));

  beforeAll(async () => {
    db = await startTestPostgres();
    pool = db.pool;
  });

  afterAll(async () => {
    await db.stop();
  });

  beforeEach(async () => {
    await db.pool.query("TRUNCATE clients, connected_accounts RESTART IDENTITY CASCADE");
    publisher.reset();
    clock.set(NOW);
  });

  async function client(subdomain = "acme"): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO clients (subdomain, timezone, facebook_enabled)
       VALUES ($1, 'America/New_York', true) RETURNING id`,
      [subdomain],
    );
    return rows[0]!.id;
  }

  /** Connect a Facebook Page whose token expires at a given time. */
  async function connectedPage(
    clientId: string,
    options: {
      expiresAt?: Date;
      refreshable?: boolean;
      accessToken?: string;
      parentToken?: string;
    } = {},
  ): Promise<void> {
    await connectAccount(pool, clock, cipher, {
      clientId,
      platform: "facebook",
      externalId: "page-a",
      displayName: "Acme Storefront",
      credential: {
        accessToken: options.accessToken ?? "page-token",
        expiresAt: options.expiresAt,
        refreshable: options.refreshable ?? true,
        platformUserId: "meta-user",
        parentToken: options.parentToken,
      },
    });
  }

  /** The stored (decrypted) access token for a Client's Facebook account. */
  async function storedToken(clientId: string): Promise<string | null> {
    const { rows } = await pool.query<{ credential: string | null }>(
      `SELECT credential FROM connected_accounts WHERE client_id = $1 AND platform = 'facebook'`,
      [clientId],
    );
    const sealed = rows[0]?.credential;
    return sealed ? openCredential(cipher, sealed).accessToken : null;
  }

  it("renews a token that is about to expire", async () => {
    const clientId = await client();
    await connectedPage(clientId, {
      accessToken: "page-token",
      expiresAt: new Date(NOW.getTime() + days(3)),
    });

    const result = await refreshDueTokens(pool, clock, cipher, publisher);

    expect(result).toMatchObject({ refreshed: 1, expired: 0 });
    expect(await storedToken(clientId)).toBe("page-token-refreshed");
  });

  it("records the renewed token's new expiry, so it is not refreshed forever", async () => {
    const clientId = await client();
    await connectedPage(clientId, { expiresAt: new Date(NOW.getTime() + days(3)) });
    publisher.scriptRefreshedExpiry(new Date(NOW.getTime() + days(60)));

    await refreshDueTokens(pool, clock, cipher, publisher);

    const account = await findAccount(pool, clientId, "facebook");
    expect(account?.tokenExpiresAt).toBe(new Date(NOW.getTime() + days(60)).toISOString());
    expect(account?.status).toBe("connected");

    // Now well outside the window, it is left alone.
    publisher.reset();
    const second = await refreshDueTokens(pool, clock, cipher, publisher);
    expect(second).toMatchObject({ refreshed: 0 });
    expect(publisher.refreshed).toHaveLength(0);
  });

  it("leaves a token that is not near expiry alone", async () => {
    const clientId = await client();
    await connectedPage(clientId, { expiresAt: new Date(NOW.getTime() + days(30)) });

    const result = await refreshDueTokens(pool, clock, cipher, publisher);

    expect(result).toMatchObject({ refreshed: 0, expired: 0 });
    expect(publisher.refreshed).toHaveLength(0);
    expect(await storedToken(clientId)).toBe("page-token");
  });

  it("refreshes a token the moment it enters the refresh window", async () => {
    const clientId = await client();
    // Just outside the window: nothing to do yet.
    await connectedPage(clientId, {
      expiresAt: new Date(NOW.getTime() + REFRESH_WINDOW_MS + hours(1)),
    });
    expect(await refreshDueTokens(pool, clock, cipher, publisher)).toMatchObject({
      refreshed: 0,
    });

    // An hour later the same token is due.
    clock.advance(hours(2));
    expect(await refreshDueTokens(pool, clock, cipher, publisher)).toMatchObject({
      refreshed: 1,
    });
  });

  it("marks an account token_expired when the platform refuses to renew it", async () => {
    const clientId = await client();
    await connectedPage(clientId, { expiresAt: new Date(NOW.getTime() + days(3)) });
    publisher.scriptRefreshFailure("Session has been invalidated.");

    const result = await refreshDueTokens(pool, clock, cipher, publisher);

    expect(result).toMatchObject({ refreshed: 0, expired: 1 });
    // The User needs to see "reconnect", not a Post failing later for no reason.
    const account = await findAccount(pool, clientId, "facebook");
    expect(account?.status).toBe("token_expired");
    // The Page is still named: the User is reconnecting *this* Page.
    expect(account?.externalId).toBe("page-a");
  });

  it("does not retry an account it already marked token_expired", async () => {
    const clientId = await client();
    await connectedPage(clientId, { expiresAt: new Date(NOW.getTime() + days(3)) });
    publisher.scriptRefreshFailure("Session has been invalidated.");
    await refreshDueTokens(pool, clock, cipher, publisher);

    publisher.reset();
    const result = await refreshDueTokens(pool, clock, cipher, publisher);

    expect(result).toMatchObject({ refreshed: 0, expired: 0 });
    expect(publisher.refreshed).toHaveLength(0);
  });

  it("ignores a disconnected account", async () => {
    const clientId = await client();
    await connectedPage(clientId, { expiresAt: new Date(NOW.getTime() + days(3)) });
    await disconnectAccount(pool, clock, { clientId, platform: "facebook" });

    const result = await refreshDueTokens(pool, clock, cipher, publisher);

    expect(result).toMatchObject({ refreshed: 0, expired: 0 });
    expect(publisher.refreshed).toHaveLength(0);
  });

  it("ignores a token that cannot be refreshed (ADR 0008: pasted by hand)", async () => {
    const clientId = await client();
    await connectedPage(clientId, {
      expiresAt: new Date(NOW.getTime() + days(3)),
      refreshable: false,
    });

    const result = await refreshDueTokens(pool, clock, cipher, publisher);

    // Nothing to attempt: only a human can regenerate it.
    expect(result).toMatchObject({ refreshed: 0, expired: 0 });
    expect(publisher.refreshed).toHaveLength(0);
  });

  it("ignores an account whose token has no known expiry", async () => {
    const clientId = await client();
    await connectedPage(clientId, { expiresAt: undefined });

    const result = await refreshDueTokens(pool, clock, cipher, publisher);

    expect(result).toMatchObject({ refreshed: 0, expired: 0 });
    expect(publisher.refreshed).toHaveLength(0);
  });

  it("sends the stored token to the platform, decrypted", async () => {
    const clientId = await client();
    await connectedPage(clientId, {
      accessToken: "the-real-page-token",
      expiresAt: new Date(NOW.getTime() + days(3)),
    });

    await refreshDueTokens(pool, clock, cipher, publisher);

    expect(publisher.refreshed[0]).toMatchObject({ accessToken: "the-real-page-token" });
  });

  it("tells the platform which destination the credential is for", async () => {
    const clientId = await client();
    await connectedPage(clientId, { expiresAt: new Date(NOW.getTime() + days(3)) });

    await refreshDueTokens(pool, clock, cipher, publisher);

    // Meta cannot extend a Page token in place — it re-derives it from the
    // refreshed user token, and has to be told which Page.
    expect(publisher.refreshRequests[0]).toMatchObject({
      platform: "facebook",
      externalId: "page-a",
    });
  });

  it("keeps the parent token across a refresh, so the next one can still run", async () => {
    const clientId = await client();
    await connectedPage(clientId, {
      accessToken: "page-token",
      parentToken: "the-user-token",
      expiresAt: new Date(NOW.getTime() + days(3)),
    });

    await refreshDueTokens(pool, clock, cipher, publisher);

    expect(publisher.refreshed[0]).toMatchObject({ parentToken: "the-user-token" });
    const { rows } = await pool.query<{ credential: string }>(
      `SELECT credential FROM connected_accounts WHERE client_id = $1`,
      [clientId],
    );
    expect(openCredential(cipher, rows[0]!.credential).parentToken).toBe("the-user-token");
  });

  it("keeps going when one Client's refresh fails, so one bad token cannot stall the rest", async () => {
    const good = await client("acme");
    const bad = await client("globex");
    const dueSoon = { expiresAt: new Date(NOW.getTime() + days(3)) };
    await connectedPage(good, { ...dueSoon, accessToken: "good-token" });
    await connectedPage(bad, { ...dueSoon, accessToken: "doomed-token" });
    publisher.scriptRefreshFailureFor("doomed-token", "Session has been invalidated.");

    const result = await refreshDueTokens(pool, clock, cipher, publisher);

    expect(result).toMatchObject({ refreshed: 1, expired: 1 });
    // Every due account was attempted, whatever order they came in.
    expect(publisher.refreshed).toHaveLength(2);
    expect(await storedToken(good)).toBe("good-token-refreshed");
    expect((await findAccount(pool, bad, "facebook"))?.status).toBe("token_expired");
    expect((await findAccount(pool, good, "facebook"))?.status).toBe("connected");
  });
});
