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
 * The two surfaces under test: the Superadmin sets a Client's logo/color/name on
 * the `admin.` surface, and the Client SPA reads the resolved branding from its
 * own subdomain (publicly, before login). The default fallback and per-Client
 * scoping are the load-bearing invariants.
 */

const BASE_DOMAIN = "ourapp.test";
const SUPERADMIN_TOKEN = "test-superadmin-token";
const ADMIN_HOST = `admin.${BASE_DOMAIN}`;
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

  /** Provision a Client and return its id. */
  async function createClient(subdomain: string): Promise<string> {
    const { clientId } = await provisionClient(db.pool, { subdomain });
    return clientId;
  }

  /** Set a Client's branding via the Superadmin surface. */
  function setBranding(clientId: string, patch: Record<string, unknown>) {
    return app.inject({
      method: "PATCH",
      url: `/api/admin/clients/${clientId}/branding`,
      headers: { host: ADMIN_HOST, ...adminAuth },
      payload: patch,
    });
  }

  /** Read the branding the Client SPA would see on a given subdomain. */
  function getBranding(subdomain: string) {
    return app.inject({
      method: "GET",
      url: "/api/branding",
      headers: { host: host(subdomain) },
    });
  }

  describe("Superadmin sets branding (admin. surface)", () => {
    it("sets a Client's logo, primary color, and app name", async () => {
      const clientId = await createClient("acme");
      const res = await setBranding(clientId, {
        appName: "Acme Social",
        primaryColor: "#FF6600",
        logoUrl: "https://cdn.acme.test/logo.png",
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().branding).toEqual({
        appName: "Acme Social",
        primaryColor: "#ff6600", // normalized to lowercase
        logoUrl: "https://cdn.acme.test/logo.png",
      });
    });

    it("applies only the fields sent, leaving the rest unchanged", async () => {
      const clientId = await createClient("acme");
      await setBranding(clientId, { appName: "Acme Social", primaryColor: "#ff6600" });

      // A second patch touching only the logo must not clear the name/color.
      const res = await setBranding(clientId, { logoUrl: "https://cdn.acme.test/l.png" });
      expect(res.json().branding).toEqual({
        appName: "Acme Social",
        primaryColor: "#ff6600",
        logoUrl: "https://cdn.acme.test/l.png",
      });
    });

    it("resets a field to the neutral default when sent as null", async () => {
      const clientId = await createClient("acme");
      await setBranding(clientId, {
        appName: "Acme Social",
        primaryColor: "#ff6600",
        logoUrl: "https://cdn.acme.test/l.png",
      });

      const res = await setBranding(clientId, { appName: null, logoUrl: null });
      expect(res.json().branding).toEqual({
        appName: DEFAULT_BRANDING.appName, // back to default
        primaryColor: "#ff6600", // untouched
        logoUrl: null, // cleared
      });
    });

    it("rejects an invalid color, logo URL, and app name with 400", async () => {
      const clientId = await createClient("acme");
      const cases: Array<[Record<string, unknown>, string]> = [
        [{ primaryColor: "red" }, "invalid_primary_color"],
        [{ primaryColor: "#fff" }, "invalid_primary_color"],
        [{ logoUrl: "not-a-url" }, "invalid_logo_url"],
        [{ logoUrl: "ftp://cdn.acme.test/l.png" }, "invalid_logo_url"],
        [{ appName: "   " }, "invalid_app_name"],
        [{ appName: "x".repeat(81) }, "invalid_app_name"],
      ];
      for (const [payload, error] of cases) {
        const res = await setBranding(clientId, payload);
        expect(res.statusCode).toBe(400);
        expect(res.json().error).toBe(error);
      }
    });

    it("404s branding for an unknown Client", async () => {
      const res = await setBranding("00000000-0000-0000-0000-000000000000", {
        appName: "Ghost",
      });
      expect(res.statusCode).toBe(404);
    });

    it("is gated: 404 off the admin surface, 401 without the token", async () => {
      const clientId = await createClient("acme");

      const wrongSurface = await app.inject({
        method: "PATCH",
        url: `/api/admin/clients/${clientId}/branding`,
        headers: { host: host("acme"), ...adminAuth },
        payload: { appName: "Sneaky" },
      });
      expect(wrongSurface.statusCode).toBe(404);

      const noToken = await app.inject({
        method: "PATCH",
        url: `/api/admin/clients/${clientId}/branding`,
        headers: { host: ADMIN_HOST },
        payload: { appName: "Sneaky" },
      });
      expect(noToken.statusCode).toBe(401);
    });
  });

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
