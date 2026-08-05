import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance, InjectOptions } from "fastify";
import { buildTestAdminApp, loginAs } from "./helpers/app.js";
import { startTestPostgres, type TestPostgres } from "./helpers/postgres.js";
import { buildTestClientApp, clientHost } from "./helpers/client-app.js";
import { FakeEmailSender } from "../../server/src/core/fake-email.js";
import { TestClock } from "../src/clock.js";
import { upsertSuperadmin } from "../src/auth/superadmins.js";

/**
 * A Client's Users — the panel's most-used section, and the one that decides
 * what every Client's first password looks like.
 *
 * Both services are built here against one database, because most of what this
 * section claims is only provable from the other side: that the credential the
 * panel just generated actually logs in at the Client's subdomain, and that a
 * reset really does end the sessions and the pending reset links that were live
 * a moment earlier. A 200 from the panel proves none of that by itself.
 */

const OPERATOR_EMAIL = "operator@ourapp.test";
const OPERATOR_PASSWORD = "correct horse battery";

/**
 * The shape a generated password promises: four hyphen-separated groups of five
 * characters, drawn from an alphabet with no `l`/`I`/`1` or `O`/`0` in it.
 *
 * Pinned because "strong" is otherwise unfalsifiable — a base-36 timestamp is
 * also long and also different every time, and would sail past a bare length
 * check. This is what makes the ~116 bits a claim the suite actually holds the
 * generator to.
 */
const GENERATED_PASSWORD = /^[a-kmnp-zA-HJ-NP-Z2-9]{5}(?:-[a-kmnp-zA-HJ-NP-Z2-9]{5}){3}$/;

describe("Users in the admin panel", () => {
  let db: TestPostgres;
  let app: FastifyInstance;
  let clientApp: FastifyInstance;
  let email: FakeEmailSender;
  let cookies: InjectOptions["cookies"];
  const clock = new TestClock(new Date("2026-08-05T09:00:00.000Z"));

  beforeAll(async () => {
    // The Client-facing schema too: a User is that service's table, and its
    // subdomain is where the credential this section hands out is used.
    db = await startTestPostgres({ clientSchema: true });
    email = new FakeEmailSender();
    app = buildTestAdminApp({ pool: db.pool, clock });
    clientApp = buildTestClientApp({ pool: db.pool, clock, emailSender: email });
    await Promise.all([app.ready(), clientApp.ready()]);
  });

  afterAll(async () => {
    await Promise.all([app.close(), clientApp.close()]);
    await db.stop();
  });

  let acme: string;
  let globex: string;

  beforeEach(async () => {
    clock.set(new Date("2026-08-05T09:00:00.000Z"));
    email.reset();
    await db.pool.query("TRUNCATE superadmins, admin_sessions RESTART IDENTITY CASCADE");
    await db.pool.query(
      "TRUNCATE clients, users, sessions, password_reset_tokens RESTART IDENTITY CASCADE",
    );
    await upsertSuperadmin(db.pool, { email: OPERATOR_EMAIL, password: OPERATOR_PASSWORD });
    ({ cookies } = await loginAs(app, { email: OPERATOR_EMAIL, password: OPERATOR_PASSWORD }));

    // Two Clients throughout, so "belonging to this Client" and "in use
    // anywhere on the platform" are distinguishable claims rather than the same
    // one said twice.
    acme = await provisionClient("acme");
    globex = await provisionClient("globex");
  });

  async function provisionClient(subdomain: string): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/api/clients",
      payload: { subdomain, timezone: "UTC" },
      cookies,
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().client.id as string;
  }

  const listUsers = (clientId: string) =>
    app.inject({ method: "GET", url: `/api/clients/${clientId}/users`, cookies });

  const addUser = (clientId: string, userEmail: unknown) =>
    app.inject({
      method: "POST",
      url: `/api/clients/${clientId}/users`,
      payload: { email: userEmail },
      cookies,
    });

  const resetPassword = (clientId: string, userId: string) =>
    app.inject({
      method: "POST",
      url: `/api/clients/${clientId}/users/${userId}/password`,
      cookies,
    });

  /** Create a User the way the panel does, returning what it handed the operator. */
  async function createUser(
    clientId: string,
    userEmail: string,
  ): Promise<{ id: string; password: string }> {
    const res = await addUser(clientId, userEmail);
    expect(res.statusCode, res.body).toBe(201);
    return { id: res.json().user.id as string, password: res.json().password as string };
  }

  /** What the Client-facing login says to these credentials, on that subdomain. */
  const clientLogin = (subdomain: string, userEmail: string, password: string) =>
    clientApp.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { host: clientHost(subdomain) },
      payload: { email: userEmail, password },
    });

  /** A live Client session token, obtained the way a User would obtain one. */
  async function loginToClient(
    subdomain: string,
    userEmail: string,
    password: string,
  ): Promise<string> {
    const res = await clientLogin(subdomain, userEmail, password);
    expect(res.statusCode, res.body).toBe(200);
    return res.json().token as string;
  }

  /** Whether a Client session token still works, asked of the Client API. */
  const clientSessionStatus = (subdomain: string, token: string) =>
    clientApp
      .inject({
        method: "GET",
        url: "/api/me",
        headers: { host: clientHost(subdomain), authorization: `Bearer ${token}` },
      })
      .then((res) => res.statusCode);

  /** Drive the Client's self-service reset far enough to hold a live link. */
  async function pendingResetToken(subdomain: string, userEmail: string): Promise<string> {
    const res = await clientApp.inject({
      method: "POST",
      url: "/api/auth/password-reset/request",
      headers: { host: clientHost(subdomain) },
      payload: { email: userEmail },
    });
    expect(res.statusCode).toBe(202);
    const message = email.to(userEmail).at(-1);
    expect(message, "a reset email should have been sent").toBeDefined();
    const match = message!.text.match(/token=([^\s&]+)/);
    expect(match, "the email should carry a reset link with a token").not.toBeNull();
    return decodeURIComponent(match![1]!);
  }

  describe("Listing", () => {
    it("lists every User belonging to that Client, and no one else's", async () => {
      await createUser(acme, "first@acme.test");
      await createUser(acme, "second@acme.test");
      await createUser(globex, "someone@globex.test");

      const res = await listUsers(acme);

      expect(res.statusCode).toBe(200);
      expect(res.json().users).toMatchObject([
        { clientId: acme, email: "first@acme.test" },
        { clientId: acme, email: "second@acme.test" },
      ]);
      // When each was provisioned, which the panel shows in its own column.
      for (const user of res.json().users) {
        expect(Number.isNaN(Date.parse(user.createdAt))).toBe(false);
      }
    });

    it("keeps the Client's first User at the top, whatever their addresses", async () => {
      // Oldest first: the Client's original login should not sink as their
      // colleagues are added. Addresses chosen so alphabetical order is the
      // reverse of insertion order — otherwise this passes on the tiebreak.
      await createUser(acme, "zoe@acme.test");
      clock.advance(60 * 1000);
      await createUser(acme, "adam@acme.test");

      const res = await listUsers(acme);

      expect(res.json().users.map((user: { email: string }) => user.email)).toEqual([
        "zoe@acme.test",
        "adam@acme.test",
      ]);
    });

    it("has an empty list for a Client with no Users yet", async () => {
      const res = await listUsers(acme);

      expect(res.statusCode).toBe(200);
      expect(res.json().users).toEqual([]);
    });

    it("has no Users to list for a Client that does not exist", async () => {
      const missing = await listUsers("2f8c6e5a-0000-4000-8000-000000000000");
      expect(missing.statusCode).toBe(404);
      expect(missing.json().error).toBe("client_not_found");

      // A malformed id names a Client that cannot exist either.
      expect((await listUsers("nonsense")).statusCode).toBe(404);
    });
  });

  describe("Creating", () => {
    it("creates a User from an email address alone", async () => {
      const res = await addUser(acme, "user@acme.test");

      expect(res.statusCode).toBe(201);
      expect(res.json().user).toMatchObject({ clientId: acme, email: "user@acme.test" });

      const { rows } = await db.pool.query("SELECT client_id, email FROM users");
      expect(rows).toEqual([{ client_id: acme, email: "user@acme.test" }]);
    });

    it("generates the password itself, rather than taking one", async () => {
      // The operator has no way to provision a weak or reused password, because
      // there is nowhere to type one: whatever is sent is not what is stored.
      const res = await app.inject({
        method: "POST",
        url: `/api/clients/${acme}/users`,
        payload: { email: "user@acme.test", password: "hunter2" },
        cookies,
      });

      expect(res.statusCode).toBe(201);
      expect(res.json().password).not.toBe("hunter2");
      expect(await clientLogin("acme", "user@acme.test", "hunter2")).toMatchObject({
        statusCode: 401,
      });
      expect(
        (await clientLogin("acme", "user@acme.test", res.json().password)).statusCode,
      ).toBe(200);
    });

    it("generates a strong password, different every time", async () => {
      const first = await createUser(acme, "first@acme.test");
      const second = await createUser(acme, "second@acme.test");
      const third = await createUser(acme, "third@acme.test");

      // Long enough that guessing it is not a strategy — this is the credential
      // the operator will send over some chat app, not a temporary code.
      for (const { password } of [first, second, third]) {
        expect(password).toMatch(GENERATED_PASSWORD);
        expect(password.length).toBeGreaterThanOrEqual(16);
      }
      expect(new Set([first.password, second.password, third.password]).size).toBe(3);
    });

    it("never stores the plaintext and never shows it again", async () => {
      const { password } = await createUser(acme, "user@acme.test");

      // Hashed, not stored (ADR 0006) — the column holds a bcrypt digest.
      const { rows } = await db.pool.query<{ password_hash: string }>(
        "SELECT password_hash FROM users",
      );
      expect(rows[0]!.password_hash).not.toContain(password);
      expect(rows[0]!.password_hash.startsWith("$2")).toBe(true);

      // And no later read carries it: shown exactly once means the list cannot
      // become a second place to find it.
      const list = await listUsers(acme);
      expect(list.body).not.toContain(password);
      // Exactly these fields and no others. A listing that grew a `password_hash`
      // would still pass the two assertions above, and handing a bcrypt digest of
      // every Client's credentials to anything that logs a response body is the
      // leak worth failing on (ADR 0006).
      expect(Object.keys(list.json().users[0]).sort()).toEqual([
        "clientId",
        "createdAt",
        "email",
        "id",
      ]);
      expect(list.body).not.toContain(rows[0]!.password_hash);
    });

    it("refuses an email already in use by any Client on the platform", async () => {
      await createUser(acme, "shared@example.test");

      // A different Client entirely: emails are globally unique, because an
      // email is one login identity on this platform, not one per tenant.
      const res = await addUser(globex, "Shared@example.test");

      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("email_taken");
      // The operator has to pick another, so the message names the conflict.
      expect(res.json().message).toContain("shared@example.test");

      const { rows } = await db.pool.query("SELECT count(*)::int AS n FROM users");
      expect(rows[0].n).toBe(1);
    });

    it("refuses a malformed email", async () => {
      // A User who can never receive a reset link is a User with no way back in.
      const res = await addUser(acme, "not an email");

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("invalid_email");
      const { rows } = await db.pool.query("SELECT count(*)::int AS n FROM users");
      expect(rows[0].n).toBe(0);
    });

    it("refuses a create with no email at all", async () => {
      const res = await addUser(acme, undefined);

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("invalid_body");
    });

    it("adds further Users to a Client that already has one", async () => {
      // A small team shares the work, so the first User is not a limit.
      await createUser(acme, "first@acme.test");
      const second = await createUser(acme, "second@acme.test");

      expect((await listUsers(acme)).json().users).toHaveLength(2);
      // Both credentials work — the second did not displace the first.
      expect((await clientLogin("acme", "second@acme.test", second.password)).statusCode).toBe(
        200,
      );
    });

    it("has no Client to create a User under when the Client does not exist", async () => {
      const res = await addUser("2f8c6e5a-0000-4000-8000-000000000000", "user@acme.test");

      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe("client_not_found");
    });

    it("creates a User who can log in on that Client's subdomain", async () => {
      // The point of creating a User is not the row — it is that someone can now
      // get in. Only the Client-facing service can say whether they can.
      const { password } = await createUser(acme, "user@acme.test");

      expect((await clientLogin("acme", "user@acme.test", password)).statusCode).toBe(200);
      // And only there: the credential is scoped to their own Client.
      expect((await clientLogin("globex", "user@acme.test", password)).statusCode).toBe(401);
    });
  });

  describe("Resetting", () => {
    it("issues a newly generated password that works and retires the old one", async () => {
      const created = await createUser(acme, "user@acme.test");

      const res = await resetPassword(acme, created.id);

      expect(res.statusCode).toBe(200);
      const fresh = res.json().password as string;
      expect(fresh).not.toBe(created.password);
      expect((await clientLogin("acme", "user@acme.test", fresh)).statusCode).toBe(200);
      expect((await clientLogin("acme", "user@acme.test", created.password)).statusCode).toBe(
        401,
      );
    });

    it("never stores the reset plaintext and never shows it again", async () => {
      const created = await createUser(acme, "user@acme.test");
      const fresh = (await resetPassword(acme, created.id)).json().password as string;

      const { rows } = await db.pool.query<{ password_hash: string }>(
        "SELECT password_hash FROM users",
      );
      expect(rows[0]!.password_hash).not.toContain(fresh);

      const list = await listUsers(acme);
      expect(list.body).not.toContain(fresh);
    });

    it("ends the User's live sessions, so the old password stops working everywhere", async () => {
      const created = await createUser(acme, "user@acme.test");
      const token = await loginToClient("acme", "user@acme.test", created.password);
      // The session worked before the reset — otherwise the assertion after it
      // would pass against a token that was never good.
      expect(await clientSessionStatus("acme", token)).toBe(200);

      await resetPassword(acme, created.id);

      // Not "expires eventually": the browser that was signed in is signed out.
      expect(await clientSessionStatus("acme", token)).toBe(401);
      const { rows } = await db.pool.query("SELECT count(*)::int AS n FROM sessions");
      expect(rows[0].n).toBe(0);
    });

    it("invalidates a pending self-service reset link", async () => {
      const created = await createUser(acme, "user@acme.test");
      const linkToken = await pendingResetToken("acme", "user@acme.test");

      await resetPassword(acme, created.id);

      // The link that was in flight is dead: the operator's reset is the last
      // word, not something a stale email can quietly override an hour later.
      const complete = await clientApp.inject({
        method: "POST",
        url: "/api/auth/password-reset/complete",
        headers: { host: clientHost("acme") },
        payload: { token: linkToken, password: "a password of their own" },
      });
      expect(complete.statusCode).toBe(400);
      expect(complete.json().error).toBe("invalid_token");
      expect(
        (await clientLogin("acme", "user@acme.test", "a password of their own")).statusCode,
      ).toBe(401);
    });

    it("leaves every other User's credentials alone", async () => {
      const one = await createUser(acme, "one@acme.test");
      const two = await createUser(acme, "two@acme.test");
      const token = await loginToClient("acme", "two@acme.test", two.password);

      await resetPassword(acme, one.id);

      expect((await clientLogin("acme", "two@acme.test", two.password)).statusCode).toBe(200);
      expect(await clientSessionStatus("acme", token)).toBe(200);
    });

    it("will not reset a User who belongs to a different Client", async () => {
      // The path names a Client; a User outside it is not this screen's to
      // touch, however the operator arrived at the id.
      const elsewhere = await createUser(globex, "someone@globex.test");

      const res = await resetPassword(acme, elsewhere.id);

      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe("user_not_found");
      // Untouched: their password still works.
      expect(
        (await clientLogin("globex", "someone@globex.test", elsewhere.password)).statusCode,
      ).toBe(200);
    });

    it("has nothing to reset for a User who does not exist", async () => {
      const missing = await resetPassword(acme, "2f8c6e5a-0000-4000-8000-000000000000");
      expect(missing.statusCode).toBe(404);
      expect(missing.json().error).toBe("user_not_found");

      expect((await resetPassword(acme, "nonsense")).statusCode).toBe(404);
    });
  });

  it("refuses every one of these routes without a session", async () => {
    const created = await createUser(acme, "user@acme.test");

    const unauthenticated = [
      { method: "GET" as const, url: `/api/clients/${acme}/users` },
      {
        method: "POST" as const,
        url: `/api/clients/${acme}/users`,
        payload: { email: "intruder@acme.test" },
      },
      { method: "POST" as const, url: `/api/clients/${acme}/users/${created.id}/password` },
    ];

    for (const request of unauthenticated) {
      const res = await app.inject(request);
      expect(res.statusCode, `${request.method} ${request.url}`).toBe(401);
      expect(res.json()).toEqual({ error: "unauthorized" });
    }

    // Nothing was written and nothing was reset: the original credential still
    // works, and no second User appeared.
    expect((await clientLogin("acme", "user@acme.test", created.password)).statusCode).toBe(200);
    const { rows } = await db.pool.query("SELECT email FROM users");
    expect(rows).toEqual([{ email: "user@acme.test" }]);
  });
});
