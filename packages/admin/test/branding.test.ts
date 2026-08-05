import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance, InjectOptions } from "fastify";
import { DEFAULT_BRANDING } from "@smma/core";
import { buildTestAdminApp, loginAs } from "./helpers/app.js";
import { startTestPostgres, type TestPostgres } from "./helpers/postgres.js";
import { buildTestClientApp, clientHost } from "./helpers/client-app.js";
import { TestClock } from "../src/clock.js";
import { upsertSuperadmin } from "../src/auth/superadmins.js";

/**
 * A Client's white-label Branding, administered from the panel.
 *
 * The claim under test is not that a column changed — it is that the Client's
 * own surface looks different afterwards. So every editing test that matters
 * ends on the Client-facing service's public branding route, fetched with no
 * session at all, because the login screen is branded before anyone
 * authenticates and is the first thing a Client's Users ever see (PRD #15
 * stories 46–50).
 *
 * The tri-state patch is the other thing worth proving here: absent leaves a
 * field alone, a string sets it, and an explicit null puts it back to the
 * neutral default — which is what lets an operator undo a change without having
 * to invent a replacement value.
 */

const EMAIL = "operator@ourapp.test";
const PASSWORD = "correct horse battery";
const NOW = new Date("2026-08-04T09:00:00.000Z");

describe("A Client's Branding in the admin panel", () => {
  let db: TestPostgres;
  let app: FastifyInstance;
  let clientApp: FastifyInstance;
  let cookies: InjectOptions["cookies"];
  const clock = new TestClock(NOW);

  beforeAll(async () => {
    db = await startTestPostgres({ clientSchema: true });
    app = buildTestAdminApp({ pool: db.pool, clock });
    clientApp = buildTestClientApp({ pool: db.pool, clock });
    await Promise.all([app.ready(), clientApp.ready()]);
  });

  afterAll(async () => {
    await Promise.all([app.close(), clientApp.close()]);
    await db.stop();
  });

  beforeEach(async () => {
    clock.set(NOW);
    await db.pool.query("TRUNCATE superadmins, admin_sessions RESTART IDENTITY CASCADE");
    await db.pool.query("TRUNCATE clients, users, sessions RESTART IDENTITY CASCADE");
    await upsertSuperadmin(db.pool, { email: EMAIL, password: PASSWORD });
    ({ cookies } = await loginAs(app, { email: EMAIL, password: PASSWORD }));
  });

  /* ------------------------------------------------------------ the panel */

  const readBranding = (clientId: string) =>
    app.inject({ method: "GET", url: `/api/clients/${clientId}/branding`, cookies });

  const setBranding = (clientId: string, body: Record<string, unknown>) =>
    app.inject({
      method: "PATCH",
      url: `/api/clients/${clientId}/branding`,
      payload: body,
      cookies,
    });

  /** Provision a Client through the panel, exactly as an operator would. */
  async function client(subdomain = "acme"): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/api/clients",
      payload: { subdomain, timezone: "America/New_York" },
      cookies,
    });
    if (res.statusCode !== 201) throw new Error(`Provisioning failed: ${res.body}`);
    return res.json().client.id as string;
  }

  /* ---------------------------------------------------- the Client's side */

  /**
   * What this Client's login screen renders — fetched from its own subdomain
   * with no credentials, which is the state a Client's User is in when they
   * first see it.
   */
  const loginScreenBranding = (subdomain: string) =>
    clientApp.inject({
      method: "GET",
      url: "/api/branding",
      headers: { host: clientHost(subdomain) },
    });

  /* ------------------------------------------------------------ Reading it */

  it("shows the neutral default for a Client that has set nothing", async () => {
    const clientId = await client();

    const res = await readBranding(clientId);

    expect(res.statusCode).toBe(200);
    expect(res.json().branding).toEqual(DEFAULT_BRANDING);
  });

  it("shows the values as they stand, so the operator edits from what is live", async () => {
    const clientId = await client();
    await setBranding(clientId, { appName: "Acme Social", primaryColor: "#FF6600" });

    const res = await readBranding(clientId);

    expect(res.json().branding).toEqual({
      appName: "Acme Social",
      // Normalized on the way in, and shown back in the form it was stored in
      // rather than the form it was typed in.
      primaryColor: "#ff6600",
      logoUrl: null,
    });
  });

  /* ------------------------------------------------------------ Editing it */

  it("sets the logo, the primary color, and the app name, and the Client's login screen shows them", async () => {
    const clientId = await client();

    const res = await setBranding(clientId, {
      appName: "Acme Social",
      primaryColor: "#FF6600",
      logoUrl: "https://cdn.acme.test/logo.png",
    });

    expect(res.statusCode).toBe(200);
    const branding = {
      appName: "Acme Social",
      primaryColor: "#ff6600",
      logoUrl: "https://cdn.acme.test/logo.png",
    };
    expect(res.json().branding).toEqual(branding);

    // The point of the whole section: what a Client's Users see, before any of
    // them has logged in.
    const spa = await loginScreenBranding("acme");
    expect(spa.statusCode).toBe(200);
    expect(spa.json().branding).toEqual(branding);
  });

  it("leaves the fields it was not given alone", async () => {
    const clientId = await client();
    await setBranding(clientId, { appName: "Acme Social", primaryColor: "#ff6600" });

    const res = await setBranding(clientId, { logoUrl: "https://cdn.acme.test/logo.png" });

    expect(res.json().branding).toEqual({
      appName: "Acme Social",
      primaryColor: "#ff6600",
      logoUrl: "https://cdn.acme.test/logo.png",
    });
  });

  it("resets a field to the neutral default when it is sent as null", async () => {
    const clientId = await client();
    await setBranding(clientId, {
      appName: "Acme Social",
      primaryColor: "#ff6600",
      logoUrl: "https://cdn.acme.test/logo.png",
    });

    // An undo that needs no replacement value — the whole reason the wire has a
    // third state rather than only "leave it" and "set it".
    const res = await setBranding(clientId, { appName: null, logoUrl: null });

    expect(res.json().branding).toEqual({
      appName: DEFAULT_BRANDING.appName,
      primaryColor: "#ff6600",
      logoUrl: null,
    });
    expect((await loginScreenBranding("acme")).json().branding).toEqual({
      appName: DEFAULT_BRANDING.appName,
      primaryColor: "#ff6600",
      logoUrl: null,
    });
  });

  it("names no operator once every field is back to the default", async () => {
    const clientId = await client();
    await setBranding(clientId, {
      appName: "Acme Social",
      primaryColor: "#ff6600",
      logoUrl: "https://cdn.acme.test/logo.png",
    });

    await setBranding(clientId, { appName: null, primaryColor: null, logoUrl: null });

    // A Client surface shows no operator identity anywhere (CONTEXT.md
    // `Branding`), so the fallback has to be neutral prose rather than ours.
    const spa = await loginScreenBranding("acme");
    expect(spa.json().branding).toEqual(DEFAULT_BRANDING);
    expect(JSON.stringify(spa.json())).not.toMatch(/smma|superadmin|operator|admin/i);
  });

  it("brands each Client on its own subdomain and no other", async () => {
    const acme = await client("acme");
    const globex = await client("globex");

    await setBranding(acme, { appName: "Acme Social" });
    await setBranding(globex, { appName: "Globex Hub" });

    expect((await loginScreenBranding("acme")).json().branding.appName).toBe("Acme Social");
    expect((await loginScreenBranding("globex")).json().branding.appName).toBe("Globex Hub");
  });

  /* ----------------------------------------------------------- Bad values */

  /**
   * Every one of these reaches a Client's login screen before anyone
   * authenticates, so a typo here is visible to a Client's Users and to nobody
   * who could explain it. They are refused at the door rather than stored and
   * rendered.
   */
  it("refuses a value the Client SPA could not render", async () => {
    const clientId = await client();
    const refusals: Array<[Record<string, unknown>, string]> = [
      [{ primaryColor: "red" }, "invalid_primary_color"],
      [{ primaryColor: "#fff" }, "invalid_primary_color"],
      [{ primaryColor: 16711680 }, "invalid_primary_color"],
      [{ logoUrl: "/logo.png" }, "invalid_logo_url"],
      [{ logoUrl: "ftp://cdn.acme.test/logo.png" }, "invalid_logo_url"],
      [{ logoUrl: 7 }, "invalid_logo_url"],
      [{ appName: "   " }, "invalid_app_name"],
      [{ appName: "x".repeat(81) }, "invalid_app_name"],
      [{ appName: false }, "invalid_app_name"],
    ];

    for (const [payload, error] of refusals) {
      const res = await setBranding(clientId, payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json().error, JSON.stringify(payload)).toBe(error);
    }

    // And none of them left anything behind on the way through.
    expect((await readBranding(clientId)).json().branding).toEqual(DEFAULT_BRANDING);
  });

  it("refuses a patch that names nothing, rather than reporting a change it did not make", async () => {
    const clientId = await client();

    const res = await setBranding(clientId, { appNmae: "Acme Social" });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_body");
  });

  it("answers 404 for a Client that does not exist", async () => {
    const missing = "00000000-0000-0000-0000-000000000000";

    expect((await readBranding(missing)).statusCode).toBe(404);
    const written = await setBranding(missing, { appName: "Ghost" });
    expect(written.statusCode).toBe(404);
    expect(written.json().error).toBe("client_not_found");
  });

  /* --------------------------------------------------------- The front door */

  it("rejects both of these routes for a request with no session", async () => {
    const clientId = await client();
    await setBranding(clientId, { appName: "Acme Social" });

    const unauthenticated = await Promise.all([
      app.inject({ method: "GET", url: `/api/clients/${clientId}/branding` }),
      app.inject({
        method: "PATCH",
        url: `/api/clients/${clientId}/branding`,
        payload: { appName: "Sneaky" },
      }),
    ]);

    for (const res of unauthenticated) {
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: "unauthorized" });
    }

    // And the Client whose look the caller aimed at is untouched.
    expect((await loginScreenBranding("acme")).json().branding.appName).toBe("Acme Social");
  });
});
