import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildTestApp } from "./helpers/app.js";
import { TestClock } from "../src/core/clock.js";
import { FakePublisher } from "../src/core/fake-publisher.js";
import { FakeEmailSender } from "../src/core/fake-email.js";
import { startTestPostgres, type TestPostgres } from "./helpers/postgres.js";
import { provisionClientWithUser, TEST_PASSWORD } from "./helpers/provision.js";
import { updatePlan } from "@smma/core";

/**
 * Slice 3 behavioral suite — Plan gating and access control, driven through the
 * real Fastify API against a real, throwaway Postgres. Every assertion is on
 * observable behavior: HTTP responses and resulting DB state.
 *
 * Two gates are exercised: platform toggles (what a User sees and may act on)
 * and access status (whether a User can log in / act at all).
 */

const BASE_DOMAIN = "ourapp.test";
const SUPERADMIN_TOKEN = "test-superadmin-token";
const ADMIN_HOST = `admin.${BASE_DOMAIN}`;
const host = (subdomain: string) => `${subdomain}.${BASE_DOMAIN}`;

describe("Plan gating and access status", () => {
  let db: TestPostgres;
  let app: FastifyInstance;
  const clock = new TestClock(new Date("2026-07-14T09:00:00.000Z"));

  const adminAuth = { authorization: `Bearer ${SUPERADMIN_TOKEN}` };

  beforeAll(async () => {
    db = await startTestPostgres();
    app = buildTestApp({
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

  beforeEach(async () => {
    await db.pool.query("TRUNCATE clients, users, sessions RESTART IDENTITY CASCADE");
  });

  /** Provision a Client (with an optional Plan) + first User; returns the ids. */
  async function provision(
    subdomain: string,
    email: string,
    plan?: Partial<{ facebook: boolean; instagram: boolean; tiktok: boolean }>,
  ): Promise<{ clientId: string; userId: string }> {
    return provisionClientWithUser(db.pool, { subdomain, email, plan });
  }

  async function loginToken(subdomain: string, email: string): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { host: host(subdomain) },
      payload: { email, password: TEST_PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    return res.json().token as string;
  }

  async function setPlan(
    clientId: string,
    patch: Record<string, unknown>,
  ): Promise<ReturnType<FastifyInstance["inject"]>> {
    return app.inject({
      method: "PATCH",
      url: `/api/admin/clients/${clientId}/plan`,
      headers: { host: ADMIN_HOST, ...adminAuth },
      payload: patch,
    });
  }

  describe("Superadmin sets platform toggles and access status", () => {
    it("defaults a new Client to all platforms off and active", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/admin/clients",
        headers: { host: ADMIN_HOST, ...adminAuth },
        payload: { subdomain: "acme", timezone: "America/New_York" },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().plan).toEqual({
        facebook: false,
        instagram: false,
        tiktok: false,
        accessStatus: "active",
      });
    });

    it("provisions a Client with an explicit Plan", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/admin/clients",
        headers: { host: ADMIN_HOST, ...adminAuth },
        payload: {
          subdomain: "acme",
          timezone: "America/New_York",
          plan: { tiktok: true },
        },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().plan).toMatchObject({
        facebook: false,
        instagram: false,
        tiktok: true,
      });
    });

    it("toggles each platform on and off after creation", async () => {
      const { clientId } = await provision("acme", "u@acme.test");

      const on = await setPlan(clientId, { facebook: true, instagram: true });
      expect(on.statusCode).toBe(200);
      expect(on.json().plan).toMatchObject({ facebook: true, instagram: true, tiktok: false });

      const off = await setPlan(clientId, { facebook: false });
      expect(off.statusCode).toBe(200);
      expect(off.json().plan).toMatchObject({ facebook: false, instagram: true });
    });

    it("sets access status to active, suspended, or expired", async () => {
      const { clientId } = await provision("acme", "u@acme.test");
      for (const accessStatus of ["suspended", "expired", "active"] as const) {
        const res = await setPlan(clientId, { accessStatus });
        expect(res.statusCode).toBe(200);
        expect(res.json().plan.accessStatus).toBe(accessStatus);
      }
    });

    it("rejects an unknown access status with 400", async () => {
      const { clientId } = await provision("acme", "u@acme.test");
      const res = await setPlan(clientId, { accessStatus: "cancelled" });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("invalid_access_status");
    });

    it("404s a plan update for an unknown Client", async () => {
      const res = await setPlan("00000000-0000-0000-0000-000000000000", { facebook: true });
      expect(res.statusCode).toBe(404);
    });

    it("shows every Client's access status in the single global view", async () => {
      const acme = await provision("acme", "a@acme.test");
      await provision("globex", "b@globex.test");
      await updatePlan(db.pool, acme.clientId, { accessStatus: "suspended" });

      const res = await app.inject({
        method: "GET",
        url: "/api/admin/clients",
        headers: { host: ADMIN_HOST, ...adminAuth },
      });
      expect(res.statusCode).toBe(200);
      const byName = Object.fromEntries(
        (res.json() as Array<{ subdomain: string; plan: { accessStatus: string } }>).map((c) => [
          c.subdomain,
          c.plan.accessStatus,
        ]),
      );
      expect(byName).toEqual({ acme: "suspended", globex: "active" });
    });

    it("gates the plan route to the admin surface + token", async () => {
      const { clientId } = await provision("acme", "u@acme.test");

      const noToken = await app.inject({
        method: "PATCH",
        url: `/api/admin/clients/${clientId}/plan`,
        headers: { host: ADMIN_HOST },
        payload: { facebook: true },
      });
      expect(noToken.statusCode).toBe(401);

      const fromClient = await app.inject({
        method: "PATCH",
        url: `/api/admin/clients/${clientId}/plan`,
        headers: { host: host("acme"), ...adminAuth },
        payload: { facebook: true },
      });
      expect(fromClient.statusCode).toBe(404);
    });
  });

  describe("Access status gates login", () => {
    it("blocks login for a suspended Client with a clear reason", async () => {
      const { clientId } = await provision("acme", "u@acme.test");
      await updatePlan(db.pool, clientId, { accessStatus: "suspended" });

      const res = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { host: host("acme") },
        payload: { email: "u@acme.test", password: TEST_PASSWORD },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("client_suspended");
    });

    it("blocks login for an expired Client with a clear reason", async () => {
      const { clientId } = await provision("acme", "u@acme.test");
      await updatePlan(db.pool, clientId, { accessStatus: "expired" });

      const res = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { host: host("acme") },
        payload: { email: "u@acme.test", password: TEST_PASSWORD },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("client_expired");
    });

    it("lets login resume once access is restored to active", async () => {
      const { clientId } = await provision("acme", "u@acme.test");
      await updatePlan(db.pool, clientId, { accessStatus: "suspended" });
      await updatePlan(db.pool, clientId, { accessStatus: "active" });

      const res = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { host: host("acme") },
        payload: { email: "u@acme.test", password: TEST_PASSWORD },
      });
      expect(res.statusCode).toBe(200);
    });
  });

  describe("Access status gates a live session", () => {
    it("revokes an existing session when the Client is suspended mid-session", async () => {
      const { clientId } = await provision("acme", "u@acme.test");
      const token = await loginToken("acme", "u@acme.test");

      // Session works while active.
      const before = await app.inject({
        method: "GET",
        url: "/api/me",
        headers: { host: host("acme"), authorization: `Bearer ${token}` },
      });
      expect(before.statusCode).toBe(200);

      await updatePlan(db.pool, clientId, { accessStatus: "suspended" });

      const after = await app.inject({
        method: "GET",
        url: "/api/me",
        headers: { host: host("acme"), authorization: `Bearer ${token}` },
      });
      expect(after.statusCode).toBe(403);
      expect(after.json().error).toBe("client_suspended");
    });

    it("blocks a plan-gated action for a suspended Client even with a live token", async () => {
      const { clientId } = await provision("acme", "u@acme.test", { tiktok: true });
      const token = await loginToken("acme", "u@acme.test");
      await updatePlan(db.pool, clientId, { accessStatus: "suspended" });

      const res = await app.inject({
        method: "GET",
        url: "/api/platforms/tiktok",
        headers: { host: host("acme"), authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("client_suspended");
    });
  });

  describe("Platform toggles gate what a User sees and may act on", () => {
    it("exposes only the enabled platforms on /api/me", async () => {
      const { clientId } = await provision("acme", "u@acme.test", { tiktok: true });
      const token = await loginToken("acme", "u@acme.test");

      const me = await app.inject({
        method: "GET",
        url: "/api/me",
        headers: { host: host("acme"), authorization: `Bearer ${token}` },
      });
      expect(me.statusCode).toBe(200);
      expect(me.json().client.plan).toMatchObject({
        facebook: false,
        instagram: false,
        tiktok: true,
      });

      await updatePlan(db.pool, clientId, { facebook: true });
      const after = await app.inject({
        method: "GET",
        url: "/api/me",
        headers: { host: host("acme"), authorization: `Bearer ${token}` },
      });
      expect(after.json().client.plan).toMatchObject({ facebook: true, tiktok: true });
    });

    it("lists only the enabled platforms on /api/platforms", async () => {
      await provision("acme", "u@acme.test", { tiktok: true, instagram: true });
      const token = await loginToken("acme", "u@acme.test");

      const res = await app.inject({
        method: "GET",
        url: "/api/platforms",
        headers: { host: host("acme"), authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      expect((res.json().platforms as string[]).sort()).toEqual(["instagram", "tiktok"]);
    });

    it("denies an action on a platform the Plan does not enable (TikTok-only → no Facebook)", async () => {
      await provision("acme", "u@acme.test", { tiktok: true });
      const token = await loginToken("acme", "u@acme.test");

      const denied = await app.inject({
        method: "GET",
        url: "/api/platforms/facebook",
        headers: { host: host("acme"), authorization: `Bearer ${token}` },
      });
      expect(denied.statusCode).toBe(403);
      expect(denied.json().error).toBe("platform_not_enabled");

      const allowed = await app.inject({
        method: "GET",
        url: "/api/platforms/tiktok",
        headers: { host: host("acme"), authorization: `Bearer ${token}` },
      });
      expect(allowed.statusCode).toBe(200);
      expect(allowed.json()).toMatchObject({ platform: "tiktok", enabled: true });
    });

    it("404s an unknown platform name", async () => {
      await provision("acme", "u@acme.test", { tiktok: true });
      const token = await loginToken("acme", "u@acme.test");
      const res = await app.inject({
        method: "GET",
        url: "/api/platforms/myspace",
        headers: { host: host("acme"), authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(404);
    });

    it("requires an authenticated session for platform routes", async () => {
      await provision("acme", "u@acme.test", { tiktok: true });
      const res = await app.inject({
        method: "GET",
        url: "/api/platforms",
        headers: { host: host("acme") },
      });
      expect(res.statusCode).toBe(401);
    });
  });
});
