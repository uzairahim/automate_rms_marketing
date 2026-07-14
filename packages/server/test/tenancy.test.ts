import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { TestClock } from "../src/core/clock.js";
import { FakePublisher } from "../src/core/fake-publisher.js";
import { FakeEmailSender } from "../src/core/fake-email.js";
import { startTestPostgres, type TestPostgres } from "./helpers/postgres.js";

/**
 * Slice 2 behavioral suite — the tenancy spine driven through the real Fastify
 * API against a real, throwaway Postgres (the PRD's primary seam). Every
 * assertion is on observable behavior: HTTP responses and resulting DB state.
 */

const BASE_DOMAIN = "ourapp.test";
const SUPERADMIN_TOKEN = "test-superadmin-token";
const ADMIN_HOST = `admin.${BASE_DOMAIN}`;
const host = (subdomain: string) => `${subdomain}.${BASE_DOMAIN}`;

describe("Tenancy spine: provisioning, subdomain tenancy, login", () => {
  let db: TestPostgres;
  let app: FastifyInstance;
  const clock = new TestClock(new Date("2026-07-14T09:00:00.000Z"));

  const adminAuth = { authorization: `Bearer ${SUPERADMIN_TOKEN}` };

  beforeAll(async () => {
    db = await startTestPostgres();
    app = buildApp({
      pool: db.pool,
      clock,
      publisher: new FakePublisher(),
      emailSender: new FakeEmailSender(),
      baseDomain: BASE_DOMAIN,
      superadminToken: SUPERADMIN_TOKEN,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await db.stop();
  });

  // Clean slate per test so email/subdomain uniqueness assertions don't collide.
  beforeEach(async () => {
    await db.pool.query("TRUNCATE clients, users, sessions RESTART IDENTITY CASCADE");
  });

  /** Provision a Client + first User; returns their ids for follow-on assertions. */
  async function provision(
    subdomain: string,
    email: string,
    password = "correct horse battery",
  ): Promise<{ clientId: string; userId: string }> {
    const clientRes = await app.inject({
      method: "POST",
      url: "/api/admin/clients",
      headers: { host: ADMIN_HOST, ...adminAuth },
      payload: { subdomain, timezone: "America/New_York" },
    });
    expect(clientRes.statusCode).toBe(201);
    const clientId = clientRes.json().id as string;

    const userRes = await app.inject({
      method: "POST",
      url: `/api/admin/clients/${clientId}/users`,
      headers: { host: ADMIN_HOST, ...adminAuth },
      payload: { email, password },
    });
    expect(userRes.statusCode).toBe(201);
    return { clientId, userId: userRes.json().id as string };
  }

  describe("Superadmin provisioning (admin. surface)", () => {
    it("creates a Client with a unique subdomain and timezone", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/admin/clients",
        headers: { host: ADMIN_HOST, ...adminAuth },
        payload: { subdomain: "acme", timezone: "America/New_York" },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ subdomain: "acme", timezone: "America/New_York" });

      const { rows } = await db.pool.query("SELECT subdomain, timezone FROM clients");
      expect(rows).toEqual([{ subdomain: "acme", timezone: "America/New_York" }]);
    });

    it("rejects a duplicate subdomain with 409", async () => {
      await provision("acme", "a@acme.test");
      const res = await app.inject({
        method: "POST",
        url: "/api/admin/clients",
        headers: { host: ADMIN_HOST, ...adminAuth },
        payload: { subdomain: "acme", timezone: "America/New_York" },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("subdomain_taken");
    });

    it("rejects an invalid subdomain, the reserved admin label, and a bad timezone", async () => {
      const cases: Array<[Record<string, string>, string]> = [
        [{ subdomain: "Not Valid", timezone: "America/New_York" }, "invalid_subdomain"],
        [{ subdomain: "admin", timezone: "America/New_York" }, "invalid_subdomain"],
        [{ subdomain: "acme", timezone: "Mars/Olympus" }, "invalid_timezone"],
      ];
      for (const [payload, error] of cases) {
        const res = await app.inject({
          method: "POST",
          url: "/api/admin/clients",
          headers: { host: ADMIN_HOST, ...adminAuth },
          payload,
        });
        expect(res.statusCode).toBe(400);
        expect(res.json().error).toBe(error);
      }
    });

    it("lists all Clients in one place (single global view)", async () => {
      await provision("acme", "a@acme.test");
      await provision("globex", "b@globex.test");
      const res = await app.inject({
        method: "GET",
        url: "/api/admin/clients",
        headers: { host: ADMIN_HOST, ...adminAuth },
      });
      expect(res.statusCode).toBe(200);
      const subdomains = (res.json() as Array<{ subdomain: string }>).map((c) => c.subdomain);
      expect(subdomains.sort()).toEqual(["acme", "globex"]);
    });

    it("creates a Client's first User and stores the password only as a hash", async () => {
      const clientRes = await app.inject({
        method: "POST",
        url: "/api/admin/clients",
        headers: { host: ADMIN_HOST, ...adminAuth },
        payload: { subdomain: "acme", timezone: "America/New_York" },
      });
      const clientId = clientRes.json().id as string;

      const res = await app.inject({
        method: "POST",
        url: `/api/admin/clients/${clientId}/users`,
        headers: { host: ADMIN_HOST, ...adminAuth },
        payload: { email: "User@Acme.test", password: "correct horse battery" },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ email: "user@acme.test", clientId });

      const { rows } = await db.pool.query<{ password_hash: string }>(
        "SELECT password_hash FROM users WHERE lower(email) = 'user@acme.test'",
      );
      expect(rows[0]!.password_hash).not.toContain("correct horse battery");
      expect(rows[0]!.password_hash).toMatch(/^\$2[aby]\$/); // bcrypt
    });

    it("rejects an email that already exists anywhere on the platform", async () => {
      await provision("acme", "shared@example.test");
      // A different Client cannot reuse the same email.
      const globex = await app.inject({
        method: "POST",
        url: "/api/admin/clients",
        headers: { host: ADMIN_HOST, ...adminAuth },
        payload: { subdomain: "globex", timezone: "America/New_York" },
      });
      const res = await app.inject({
        method: "POST",
        url: `/api/admin/clients/${globex.json().id}/users`,
        headers: { host: ADMIN_HOST, ...adminAuth },
        payload: { email: "Shared@example.test", password: "another password" },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("email_taken");
    });

    it("404s when creating a User under an unknown Client", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/admin/clients/00000000-0000-0000-0000-000000000000/users",
        headers: { host: ADMIN_HOST, ...adminAuth },
        payload: { email: "x@y.test", password: "a password here" },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("Admin surface access control", () => {
    it("401s without the Superadmin token, and 401s with a wrong one", async () => {
      const noToken = await app.inject({
        method: "GET",
        url: "/api/admin/clients",
        headers: { host: ADMIN_HOST },
      });
      expect(noToken.statusCode).toBe(401);

      const wrong = await app.inject({
        method: "GET",
        url: "/api/admin/clients",
        headers: { host: ADMIN_HOST, authorization: "Bearer nope" },
      });
      expect(wrong.statusCode).toBe(401);
    });

    it("404s admin routes reached from a Client subdomain, even with the token", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/admin/clients",
        headers: { host: host("acme"), ...adminAuth },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("User login and subdomain tenant scoping", () => {
    it("logs a User in on their own Client subdomain and reaches the workspace", async () => {
      await provision("acme", "user@acme.test", "correct horse battery");

      const login = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { host: host("acme") },
        payload: { email: "user@acme.test", password: "correct horse battery" },
      });
      expect(login.statusCode).toBe(200);
      const token = login.json().token as string;
      expect(login.json().client).toMatchObject({ subdomain: "acme" });

      const me = await app.inject({
        method: "GET",
        url: "/api/me",
        headers: { host: host("acme"), authorization: `Bearer ${token}` },
      });
      expect(me.statusCode).toBe(200);
      expect(me.json()).toMatchObject({
        user: { email: "user@acme.test" },
        client: { subdomain: "acme" },
      });
    });

    it("rejects a wrong password with 401", async () => {
      await provision("acme", "user@acme.test", "correct horse battery");
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { host: host("acme") },
        payload: { email: "user@acme.test", password: "wrong password" },
      });
      expect(res.statusCode).toBe(401);
    });

    it("does not let a User authenticate against a Client they do not belong to", async () => {
      await provision("acme", "user@acme.test", "correct horse battery");
      await provision("globex", "other@globex.test", "another password here");

      // Correct credentials, wrong subdomain → indistinguishable from bad creds.
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { host: host("globex") },
        payload: { email: "user@acme.test", password: "correct horse battery" },
      });
      expect(res.statusCode).toBe(401);
    });

    it("binds a session to its Client — a token is rejected on another subdomain", async () => {
      await provision("acme", "user@acme.test", "correct horse battery");
      await provision("globex", "other@globex.test", "another password here");

      const login = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { host: host("acme") },
        payload: { email: "user@acme.test", password: "correct horse battery" },
      });
      const token = login.json().token as string;

      const crossTenant = await app.inject({
        method: "GET",
        url: "/api/me",
        headers: { host: host("globex"), authorization: `Bearer ${token}` },
      });
      expect(crossTenant.statusCode).toBe(401);
    });

    it("404s login on an unknown subdomain", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { host: host("no-such-client") },
        payload: { email: "user@acme.test", password: "correct horse battery" },
      });
      expect(res.statusCode).toBe(404);
    });
  });
});
