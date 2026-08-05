import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildTestApp } from "./helpers/app.js";
import { TestClock } from "../src/core/clock.js";
import { FakePublisher } from "../src/core/fake-publisher.js";
import { FakeEmailSender } from "../src/core/fake-email.js";
import { startTestPostgres, type TestPostgres } from "./helpers/postgres.js";
import { updateBranding } from "@smma/core";
import { provisionClient } from "./helpers/provision.js";

/**
 * Slice 5 behavioral suite — light white-label branding, driven through the real
 * Fastify API against a real, throwaway Postgres. Every assertion is on
 * observable behavior: HTTP responses and resulting DB state.
 *
 * The surface under test is the Client-facing read: the SPA resolves branding
 * from its own subdomain, publicly, before login. The default fallback and
 * per-Client scoping are the load-bearing invariants. Setting branding is the
 * operator's act and lives in `@smma/admin` (ADR 0010), so it is applied here
 * through `@smma/core` as setup.
 */

const BASE_DOMAIN = "ourapp.test";
const host = (subdomain: string) => `${subdomain}.${BASE_DOMAIN}`;

const DEFAULT_BRANDING = {
  appName: "Social Media Studio",
  primaryColor: "#334155",
  logoUrl: null,
};

describe("White-label branding", () => {
  let db: TestPostgres;
  let app: FastifyInstance;
  const clock = new TestClock(new Date("2026-07-14T09:00:00.000Z"));

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

  beforeEach(async () => {
    await db.pool.query("TRUNCATE clients, users, sessions RESTART IDENTITY CASCADE");
  });

  /** Provision a Client and return its id. */
  async function createClient(subdomain: string): Promise<string> {
    const { clientId } = await provisionClient(db.pool, { subdomain });
    return clientId;
  }

  /** Read the branding the Client SPA would see on a given subdomain. */
  function getBranding(subdomain: string) {
    return app.inject({
      method: "GET",
      url: "/api/branding",
      headers: { host: host(subdomain) },
    });
  }

  describe("Client SPA reads branding (subdomain surface)", () => {
    it("renders the Client's configured branding from its subdomain", async () => {
      const clientId = await createClient("acme");
      await updateBranding(db.pool, clientId, {
        appName: "Acme Social",
        primaryColor: "#ff6600",
        logoUrl: "https://cdn.acme.test/logo.png",
      });

      const res = await getBranding("acme");
      expect(res.statusCode).toBe(200);
      expect(res.json().branding).toEqual({
        appName: "Acme Social",
        primaryColor: "#ff6600",
        logoUrl: "https://cdn.acme.test/logo.png",
      });
    });

    it("falls back to a neutral default for a Client with no custom branding", async () => {
      await createClient("plain");
      const res = await getBranding("plain");
      expect(res.statusCode).toBe(200);
      expect(res.json().branding).toEqual(DEFAULT_BRANDING);
    });

    it("scopes the payload to the correct Client per subdomain", async () => {
      const acme = await createClient("acme");
      const globex = await createClient("globex");
      await updateBranding(db.pool, acme, { appName: "Acme Social", primaryColor: "#ff0000" });
      await updateBranding(db.pool, globex, { appName: "Globex Hub", primaryColor: "#00ff00" });

      expect((await getBranding("acme")).json().branding).toMatchObject({
        appName: "Acme Social",
        primaryColor: "#ff0000",
      });
      expect((await getBranding("globex")).json().branding).toMatchObject({
        appName: "Globex Hub",
        primaryColor: "#00ff00",
      });
    });

    it("reflects a branding change on the next fetch", async () => {
      const clientId = await createClient("acme");
      await updateBranding(db.pool, clientId, { appName: "Before" });
      expect((await getBranding("acme")).json().branding.appName).toBe("Before");

      await updateBranding(db.pool, clientId, { appName: "After" });
      expect((await getBranding("acme")).json().branding.appName).toBe("After");
    });

    it("is public — served without a session (the login screen is branded too)", async () => {
      const clientId = await createClient("acme");
      await updateBranding(db.pool, clientId, { appName: "Acme Social" });

      // No Authorization header at all.
      const res = await getBranding("acme");
      expect(res.statusCode).toBe(200);
      expect(res.json().branding.appName).toBe("Acme Social");
    });

    it("404s branding for an unknown subdomain", async () => {
      const res = await getBranding("no-such-client");
      expect(res.statusCode).toBe(404);
    });
  });
});
