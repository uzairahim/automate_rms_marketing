import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildTestApp } from "./helpers/app.js";
import { TestClock } from "../src/core/clock.js";
import { FakePublisher } from "../src/core/fake-publisher.js";
import { FakeEmailSender } from "../src/core/fake-email.js";
import { startTestPostgres, type TestPostgres } from "./helpers/postgres.js";
import { provisionClientWithUser, TEST_PASSWORD } from "./helpers/provision.js";

/**
 * Slice 2 behavioral suite — the tenancy spine driven through the real Fastify
 * API against a real, throwaway Postgres (the PRD's primary seam). Every
 * assertion is on observable behavior: HTTP responses and resulting DB state.
 *
 * Provisioning is *setup* here, not the behavior under test: it happens through
 * `@smma/core` directly, because this service has no route that provisions
 * anything (ADR 0010). The panel's own surface is covered in `@smma/admin`.
 */

const BASE_DOMAIN = "ourapp.test";
const ADMIN_HOST = `admin.${BASE_DOMAIN}`;
const host = (subdomain: string) => `${subdomain}.${BASE_DOMAIN}`;

describe("Tenancy spine: subdomain tenancy and login", () => {
  let db: TestPostgres;
  let app: FastifyInstance;
  const clock = new TestClock(new Date("2026-07-14T09:00:00.000Z"));

  // Any bearer at all, so the suite below can present one and show it opens
  // nothing. There is no longer a value that would open anything.
  const adminAuth = { authorization: "Bearer any-token-at-all" };

  beforeAll(async () => {
    db = await startTestPostgres();
    app = buildTestApp({
      pool: db.pool,
      clock,
      publisher: new FakePublisher(),
      emailSender: new FakeEmailSender(),
      baseDomain: BASE_DOMAIN,
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
    password = TEST_PASSWORD,
  ): Promise<{ clientId: string; userId: string }> {
    return provisionClientWithUser(db.pool, { subdomain, email, password });
  }

  describe("The retired Superadmin API", () => {
    /**
     * Provisioning lives in `@smma/admin` now, in a process of its own (ADR
     * 0010). What is asserted here is the absence: this service no longer
     * answers on any administrative path, whatever host the caller claims.
     *
     * The `admin.` host is the case that matters. It was never a boundary — it
     * is read off a Host header the caller writes — so a request claiming it is
     * exactly what this suite must show reaches nothing.
     */
    /** Every path the administrative API used to answer on, aimed at a given id. */
    const retiredRoutes = (id: string): Array<["GET" | "POST" | "PATCH", string]> => [
      ["POST", "/api/admin/clients"],
      ["GET", "/api/admin/clients"],
      ["POST", `/api/admin/clients/${id}/users`],
      ["PATCH", `/api/admin/clients/${id}/plan`],
      ["PATCH", `/api/admin/clients/${id}/branding`],
      ["POST", `/api/admin/users/${id}/password`],
    ];

    const CALLER_HOSTS: Array<[string, string]> = [
      ["a spoofed admin. host", ADMIN_HOST],
      ["a Client's subdomain", host("acme")],
      ["a host belonging to no surface at all", "elsewhere.test"],
    ];

    /** Everything a former administrative call might have carried, in one body. */
    const KITCHEN_SINK = {
      subdomain: "sneaky",
      timezone: "UTC",
      email: "sneak@acme.test",
      password: "a password here",
      accessStatus: "suspended",
      appName: "Sneaky",
    };

    it.each(CALLER_HOSTS)("answers 404 on every former path from %s", async (_label, callerHost) => {
      const { clientId } = await provision("acme", "u@acme.test");

      for (const [method, url] of retiredRoutes(clientId)) {
        // With a bearer token and without one: neither is a key to anything,
        // because there is no lock left behind them.
        for (const headers of [{ host: callerHost }, { host: callerHost, ...adminAuth }]) {
          const res = await app.inject({
            method,
            url,
            headers,
            ...(method === "GET" ? {} : { payload: KITCHEN_SINK }),
          });
          expect(res.statusCode, `${method} ${url} from ${callerHost}`).toBe(404);
        }
      }
    });

    it("provisions nothing, however hard the former paths are pushed", async () => {
      const { clientId } = await provision("acme", "u@acme.test");

      for (const [_label, callerHost] of CALLER_HOSTS) {
        for (const [method, url] of retiredRoutes(clientId)) {
          await app.inject({
            method,
            url,
            headers: { host: callerHost, ...adminAuth },
            ...(method === "GET" ? {} : { payload: KITCHEN_SINK }),
          });
        }
      }

      // Nothing was created, and the Client is exactly as it was provisioned.
      const { rows } = await db.pool.query<{ subdomain: string; access_status: string }>(
        "SELECT subdomain, access_status FROM clients",
      );
      expect(rows).toEqual([{ subdomain: "acme", access_status: "active" }]);
      const users = await db.pool.query<{ email: string }>("SELECT email FROM users");
      expect(users.rows.map((u) => u.email)).toEqual(["u@acme.test"]);
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
