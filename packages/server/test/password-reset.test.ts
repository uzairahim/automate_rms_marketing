import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildTestApp } from "./helpers/app.js";
import { TestClock } from "../src/core/clock.js";
import { FakePublisher } from "../src/core/fake-publisher.js";
import { FakeEmailSender } from "../src/core/fake-email.js";
import { startTestPostgres, type TestPostgres } from "./helpers/postgres.js";
import { provisionClient, provisionUser } from "./helpers/provision.js";

/**
 * Slice 4 behavioral suite — additional Users and the *self-service* password
 * reset lifecycle, driven through the real Fastify API against a real, throwaway
 * Postgres. The email provider is the one fake ({@link FakeEmailSender}): a test
 * reads the reset link out of the captured message and drives the flow with it,
 * so the whole issue → email → consume path is exercised without sending real
 * mail. Expiry is driven by the injected {@link TestClock}, never real waiting.
 *
 * The operator's out-of-band reset is a different flow on a different service:
 * `@smma/admin` owns it and asserts it there, including that it ends the User's
 * live sessions and invalidates any link issued by the flow below.
 */

const BASE_DOMAIN = "ourapp.test";
const host = (subdomain: string) => `${subdomain}.${BASE_DOMAIN}`;

const PASSWORD = "correct horse battery";
const NEW_PASSWORD = "a brand new passphrase";

describe("Additional Users and password reset", () => {
  let db: TestPostgres;
  let app: FastifyInstance;
  let email: FakeEmailSender;
  const clock = new TestClock(new Date("2026-07-14T09:00:00.000Z"));

  beforeAll(async () => {
    db = await startTestPostgres();
    email = new FakeEmailSender();
    app = buildTestApp({
      pool: db.pool,
      clock,
      publisher: new FakePublisher(),
      emailSender: email,
      baseDomain: BASE_DOMAIN,
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
    const { clientId } = await provisionClient(db.pool, { subdomain });
    return clientId;
  }

  /** Create a User under a Client and return its id. */
  async function createUser(
    clientId: string,
    userEmail: string,
    password = PASSWORD,
  ): Promise<string> {
    const { userId } = await provisionUser(db.pool, clientId, {
      email: userEmail,
      password,
    });
    return userId;
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
    it("lets a Client have several Users, each able to log in", async () => {
      const clientId = await createClient("acme");
      for (const userEmail of ["first@acme.test", "second@acme.test"]) {
        await createUser(clientId, userEmail);
      }

      const { rows } = await db.pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM users WHERE client_id = $1",
        [clientId],
      );
      expect(rows[0]!.count).toBe("2");
      expect(await loginStatus("acme", "first@acme.test", PASSWORD)).toBe(200);
      expect(await loginStatus("acme", "second@acme.test", PASSWORD)).toBe(200);
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
});
