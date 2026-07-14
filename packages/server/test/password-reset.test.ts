import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { TestClock } from "../src/core/clock.js";
import { FakePublisher } from "../src/core/fake-publisher.js";
import { FakeEmailSender } from "../src/core/fake-email.js";
import { startTestPostgres, type TestPostgres } from "./helpers/postgres.js";

/**
 * Slice 4 behavioral suite — additional Users and the password-reset lifecycle,
 * driven through the real Fastify API against a real, throwaway Postgres. The
 * email provider is the one fake ({@link FakeEmailSender}): a test reads the
 * reset link out of the captured message and drives the flow with it, so the
 * whole issue → email → consume path is exercised without sending real mail.
 * Expiry is driven by the injected {@link TestClock}, never real waiting.
 */

const BASE_DOMAIN = "ourapp.test";
const SUPERADMIN_TOKEN = "test-superadmin-token";
const ADMIN_HOST = `admin.${BASE_DOMAIN}`;
const host = (subdomain: string) => `${subdomain}.${BASE_DOMAIN}`;

const PASSWORD = "correct horse battery";
const NEW_PASSWORD = "a brand new passphrase";

describe("Additional Users and password reset", () => {
  let db: TestPostgres;
  let app: FastifyInstance;
  let email: FakeEmailSender;
  const clock = new TestClock(new Date("2026-07-14T09:00:00.000Z"));

  const adminAuth = { authorization: `Bearer ${SUPERADMIN_TOKEN}` };

  beforeAll(async () => {
    db = await startTestPostgres();
    email = new FakeEmailSender();
    app = buildApp({
      pool: db.pool,
      clock,
      publisher: new FakePublisher(),
      emailSender: email,
      baseDomain: BASE_DOMAIN,
      superadminToken: SUPERADMIN_TOKEN,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await db.stop();
  });

  beforeEach(async () => {
    await db.pool.query(
      "TRUNCATE clients, users, sessions, password_reset_tokens RESTART IDENTITY CASCADE",
    );
    email.reset();
    clock.set(new Date("2026-07-14T09:00:00.000Z"));
  });

  /** Provision a Client and return its id. */
  async function createClient(subdomain: string): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/clients",
      headers: { host: ADMIN_HOST, ...adminAuth },
      payload: { subdomain, timezone: "America/New_York" },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  }

  /** Create a User under a Client and return its id. */
  async function createUser(
    clientId: string,
    userEmail: string,
    password = PASSWORD,
  ): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: `/api/admin/clients/${clientId}/users`,
      headers: { host: ADMIN_HOST, ...adminAuth },
      payload: { email: userEmail, password },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  }

  function loginStatus(subdomain: string, userEmail: string, password: string) {
    return app
      .inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { host: host(subdomain) },
        payload: { email: userEmail, password },
      })
      .then((res) => res.statusCode);
  }

  /** Request a reset and pull the raw token out of the emailed link. */
  async function requestResetToken(
    subdomain: string,
    userEmail: string,
  ): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/password-reset/request",
      headers: { host: host(subdomain) },
      payload: { email: userEmail },
    });
    expect(res.statusCode).toBe(202);
    const message = email.to(userEmail).at(-1);
    expect(message, "a reset email should have been sent").toBeDefined();
    const match = message!.text.match(/token=([^\s&]+)/);
    expect(match, "the email should contain a reset link with a token").not.toBeNull();
    return decodeURIComponent(match![1]!);
  }

  describe("Additional Users", () => {
    it("lets the Superadmin add more than one User to a Client", async () => {
      const clientId = await createClient("acme");
      await createUser(clientId, "first@acme.test");
      await createUser(clientId, "second@acme.test");

      const { rows } = await db.pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM users WHERE client_id = $1",
        [clientId],
      );
      expect(rows[0]!.count).toBe("2");
      expect(await loginStatus("acme", "second@acme.test", PASSWORD)).toBe(200);
    });

    it("still enforces global email uniqueness for an additional User", async () => {
      const acme = await createClient("acme");
      const globex = await createClient("globex");
      await createUser(acme, "shared@example.test");

      const res = await app.inject({
        method: "POST",
        url: `/api/admin/clients/${globex}/users`,
        headers: { host: ADMIN_HOST, ...adminAuth },
        payload: { email: "Shared@example.test", password: "another password" },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("email_taken");
    });
  });

  describe("Self-service reset lifecycle", () => {
    it("issues a link by email and lets the User log in with the new password", async () => {
      const clientId = await createClient("acme");
      await createUser(clientId, "user@acme.test");

      const token = await requestResetToken("acme", "user@acme.test");
      // The emailed link points back at the User's own Client subdomain.
      expect(email.last()!.text).toContain("https://acme.ourapp.test/reset-password");

      const complete = await app.inject({
        method: "POST",
        url: "/api/auth/password-reset/complete",
        headers: { host: host("acme") },
        payload: { token, password: NEW_PASSWORD },
      });
      expect(complete.statusCode).toBe(200);

      expect(await loginStatus("acme", "user@acme.test", NEW_PASSWORD)).toBe(200);
      // The old password no longer works.
      expect(await loginStatus("acme", "user@acme.test", PASSWORD)).toBe(401);
    });

    it("rejects a token that has expired", async () => {
      const clientId = await createClient("acme");
      await createUser(clientId, "user@acme.test");
      const token = await requestResetToken("acme", "user@acme.test");

      // Past the one-hour lifetime.
      clock.advance(61 * 60 * 1000);

      const res = await app.inject({
        method: "POST",
        url: "/api/auth/password-reset/complete",
        headers: { host: host("acme") },
        payload: { token, password: NEW_PASSWORD },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("invalid_token");
      // The password was not changed.
      expect(await loginStatus("acme", "user@acme.test", PASSWORD)).toBe(200);
    });

    it("cannot reuse a token after a successful reset", async () => {
      const clientId = await createClient("acme");
      await createUser(clientId, "user@acme.test");
      const token = await requestResetToken("acme", "user@acme.test");

      const first = await app.inject({
        method: "POST",
        url: "/api/auth/password-reset/complete",
        headers: { host: host("acme") },
        payload: { token, password: NEW_PASSWORD },
      });
      expect(first.statusCode).toBe(200);

      const second = await app.inject({
        method: "POST",
        url: "/api/auth/password-reset/complete",
        headers: { host: host("acme") },
        payload: { token, password: "yet another password" },
      });
      expect(second.statusCode).toBe(400);
      expect(second.json().error).toBe("invalid_token");
    });

    it("supersedes an earlier link when a new one is requested", async () => {
      const clientId = await createClient("acme");
      await createUser(clientId, "user@acme.test");

      const firstToken = await requestResetToken("acme", "user@acme.test");
      const secondToken = await requestResetToken("acme", "user@acme.test");
      expect(secondToken).not.toBe(firstToken);

      // The first link is no longer valid once a second is issued.
      const stale = await app.inject({
        method: "POST",
        url: "/api/auth/password-reset/complete",
        headers: { host: host("acme") },
        payload: { token: firstToken, password: NEW_PASSWORD },
      });
      expect(stale.statusCode).toBe(400);

      const fresh = await app.inject({
        method: "POST",
        url: "/api/auth/password-reset/complete",
        headers: { host: host("acme") },
        payload: { token: secondToken, password: NEW_PASSWORD },
      });
      expect(fresh.statusCode).toBe(200);
    });

    it("does not honor a token on a different Client's subdomain", async () => {
      const acme = await createClient("acme");
      await createClient("globex");
      await createUser(acme, "user@acme.test");
      const token = await requestResetToken("acme", "user@acme.test");

      const res = await app.inject({
        method: "POST",
        url: "/api/auth/password-reset/complete",
        headers: { host: host("globex") },
        payload: { token, password: NEW_PASSWORD },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("invalid_token");
    });

    it("rejects a new password that is too weak", async () => {
      const clientId = await createClient("acme");
      await createUser(clientId, "user@acme.test");
      const token = await requestResetToken("acme", "user@acme.test");

      const res = await app.inject({
        method: "POST",
        url: "/api/auth/password-reset/complete",
        headers: { host: host("acme") },
        payload: { token, password: "short" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("weak_password");
    });

    it("acknowledges an unknown email without sending mail (no user enumeration)", async () => {
      await createClient("acme");

      const res = await app.inject({
        method: "POST",
        url: "/api/auth/password-reset/request",
        headers: { host: host("acme") },
        payload: { email: "nobody@acme.test" },
      });
      // Same generic acknowledgement as for a real User...
      expect(res.statusCode).toBe(202);
      // ...but nothing is actually sent.
      expect(email.sent).toHaveLength(0);
    });

    it("404s a reset request on an unknown subdomain", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/password-reset/request",
        headers: { host: host("no-such-client") },
        payload: { email: "user@acme.test" },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("Superadmin direct password set", () => {
    it("sets a User's password so they can log in with it", async () => {
      const clientId = await createClient("acme");
      const userId = await createUser(clientId, "user@acme.test");

      const res = await app.inject({
        method: "POST",
        url: `/api/admin/users/${userId}/password`,
        headers: { host: ADMIN_HOST, ...adminAuth },
        payload: { password: NEW_PASSWORD },
      });
      expect(res.statusCode).toBe(200);

      expect(await loginStatus("acme", "user@acme.test", NEW_PASSWORD)).toBe(200);
      expect(await loginStatus("acme", "user@acme.test", PASSWORD)).toBe(401);
    });

    it("revokes the User's live sessions when their password is set", async () => {
      const clientId = await createClient("acme");
      const userId = await createUser(clientId, "user@acme.test");

      const login = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { host: host("acme") },
        payload: { email: "user@acme.test", password: PASSWORD },
      });
      const token = login.json().token as string;

      await app.inject({
        method: "POST",
        url: `/api/admin/users/${userId}/password`,
        headers: { host: ADMIN_HOST, ...adminAuth },
        payload: { password: NEW_PASSWORD },
      });

      const me = await app.inject({
        method: "GET",
        url: "/api/me",
        headers: { host: host("acme"), authorization: `Bearer ${token}` },
      });
      expect(me.statusCode).toBe(401);
    });

    it("404s when setting the password of an unknown User", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/admin/users/00000000-0000-0000-0000-000000000000/password",
        headers: { host: ADMIN_HOST, ...adminAuth },
        payload: { password: NEW_PASSWORD },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe("user_not_found");
    });

    it("rejects a weak password and requires the Superadmin token", async () => {
      const clientId = await createClient("acme");
      const userId = await createUser(clientId, "user@acme.test");

      const weak = await app.inject({
        method: "POST",
        url: `/api/admin/users/${userId}/password`,
        headers: { host: ADMIN_HOST, ...adminAuth },
        payload: { password: "short" },
      });
      expect(weak.statusCode).toBe(400);
      expect(weak.json().error).toBe("weak_password");

      const noToken = await app.inject({
        method: "POST",
        url: `/api/admin/users/${userId}/password`,
        headers: { host: ADMIN_HOST },
        payload: { password: NEW_PASSWORD },
      });
      expect(noToken.statusCode).toBe(401);
    });
  });
});
