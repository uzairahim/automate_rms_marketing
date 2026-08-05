import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance, InjectOptions } from "fastify";
import { updatePlan } from "@smma/core";
import { buildTestAdminApp, loginAs } from "./helpers/app.js";
import { startTestPostgres, type TestPostgres } from "./helpers/postgres.js";
import { buildTestClientApp, clientHost } from "./helpers/client-app.js";
import { TestClock } from "../src/clock.js";
import { upsertSuperadmin } from "../src/auth/superadmins.js";

/**
 * The Superadmin's single global view, and the ability to add to it.
 *
 * Driven through the real admin API as a client, asserting on responses and on
 * the resulting database state — a Client provisioned here is the same row the
 * Client-facing service will serve, so "it worked" has to mean that row exists,
 * not that a handler returned 201.
 */

const EMAIL = "operator@ourapp.test";
const PASSWORD = "correct horse battery";

describe("Clients in the admin panel", () => {
  let db: TestPostgres;
  let app: FastifyInstance;
  let clientApp: FastifyInstance;
  let cookies: InjectOptions["cookies"];
  const clock = new TestClock(new Date("2026-08-04T09:00:00.000Z"));

  beforeAll(async () => {
    // The Client-facing schema too: a Client is that service's table, and the
    // panel administers it rather than owning a copy of it.
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
    clock.set(new Date("2026-08-04T09:00:00.000Z"));
    await db.pool.query("TRUNCATE superadmins, admin_sessions RESTART IDENTITY CASCADE");
    await db.pool.query("TRUNCATE clients, users, sessions RESTART IDENTITY CASCADE");
    await upsertSuperadmin(db.pool, { email: EMAIL, password: PASSWORD });
    ({ cookies } = await loginAs(app, { email: EMAIL, password: PASSWORD }));
  });

  const provision = (body: Record<string, unknown>) =>
    app.inject({ method: "POST", url: "/api/clients", payload: body, cookies });

  /**
   * Setup, not behavior: the panel's own way to change access status arrives in
   * a later slice, and a list that distinguishes a lapsed Client needs a lapsed
   * Client to exist now. Done through core so the row is one the platform could
   * really produce.
   */
  const suspend = (clientId: string) =>
    updatePlan(db.pool, clientId, { accessStatus: "suspended" });

  it("provisions a Client with a subdomain, a timezone, and its platform toggles", async () => {
    const res = await provision({
      subdomain: "acme",
      timezone: "America/New_York",
      plan: { facebook: true, tiktok: true },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().client).toMatchObject({
      subdomain: "acme",
      timezone: "America/New_York",
      plan: { facebook: true, instagram: false, tiktok: true },
    });

    // The row the Client-facing service will serve, not just the response.
    const { rows } = await db.pool.query(
      "SELECT subdomain, timezone, facebook_enabled, instagram_enabled, tiktok_enabled FROM clients",
    );
    expect(rows).toEqual([
      {
        subdomain: "acme",
        timezone: "America/New_York",
        facebook_enabled: true,
        instagram_enabled: false,
        tiktok_enabled: true,
      },
    ]);
  });

  it("opens a new Client active, whatever the caller asked for", async () => {
    // Access status is the operator's lever over a Client that has lapsed; it is
    // not a property of provisioning one, so there is nothing to set here.
    const res = await provision({
      subdomain: "acme",
      timezone: "UTC",
      plan: { facebook: true, accessStatus: "suspended" },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().client.plan).toMatchObject({ accessStatus: "active" });
    const { rows } = await db.pool.query("SELECT access_status FROM clients");
    expect(rows).toEqual([{ access_status: "active" }]);
  });

  it("refuses a subdomain already in use, naming the collision", async () => {
    await provision({ subdomain: "acme", timezone: "UTC" });

    const res = await provision({ subdomain: "acme", timezone: "Europe/Berlin" });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("subdomain_taken");
    // The operator has to pick another one, so the message has to say which.
    expect(res.json().message).toContain("acme");

    const { rows } = await db.pool.query("SELECT count(*)::int AS n FROM clients");
    expect(rows[0].n).toBe(1);
  });

  it("refuses a subdomain that is not a usable DNS label", async () => {
    const res = await provision({ subdomain: "Acme Inc.", timezone: "UTC" });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_subdomain");
    // Actionable: it says what a subdomain may contain, not merely that this one
    // was wrong.
    expect(res.json().message).toMatch(/hyphen/i);
  });

  it("refuses the reserved `admin` label, which would shadow this very surface", async () => {
    const res = await provision({ subdomain: "admin", timezone: "UTC" });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_subdomain");
    const { rows } = await db.pool.query("SELECT count(*)::int AS n FROM clients");
    expect(rows[0].n).toBe(0);
  });

  it("refuses a timezone that is not a real timezone", async () => {
    // A typo here would anchor every one of the Client's Scheduled Posts to
    // nothing, so it is refused at the door rather than stored.
    const res = await provision({ subdomain: "acme", timezone: "America/Nowhere" });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_timezone");
    expect(res.json().message).toContain("America/Nowhere");
  });

  it("refuses a platform toggle that is not a yes or a no", async () => {
    // A toggle is what the Client may publish to; a value nobody can read as on
    // or off must not be guessed at in either direction.
    const res = await provision({
      subdomain: "acme",
      timezone: "UTC",
      plan: { facebook: "yes" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_plan");
    const { rows } = await db.pool.query("SELECT count(*)::int AS n FROM clients");
    expect(rows[0].n).toBe(0);
  });

  it("refuses a create with no subdomain or timezone at all", async () => {
    const res = await provision({});

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_body");
  });

  it("lists every Client with its access status, newest first", async () => {
    await provision({ subdomain: "first", timezone: "UTC" });
    await provision({ subdomain: "second", timezone: "UTC" });
    const third = await provision({ subdomain: "third", timezone: "UTC" });
    await suspend(third.json().client.id);

    const res = await app.inject({ method: "GET", url: "/api/clients", cookies });

    expect(res.statusCode).toBe(200);
    // Newest first, so what the operator just provisioned is where they expect it.
    expect(res.json().clients).toMatchObject([
      { subdomain: "third", plan: { accessStatus: "suspended" } },
      { subdomain: "second", plan: { accessStatus: "active" } },
      { subdomain: "first", plan: { accessStatus: "active" } },
    ]);
  });

  it("opens one Client, showing what the operator will manage there", async () => {
    const created = await provision({
      subdomain: "acme",
      timezone: "America/New_York",
      plan: { instagram: true },
    });
    const { id } = created.json().client;

    const res = await app.inject({ method: "GET", url: `/api/clients/${id}`, cookies });

    expect(res.statusCode).toBe(200);
    expect(res.json().client).toMatchObject({
      id,
      subdomain: "acme",
      timezone: "America/New_York",
      plan: { facebook: false, instagram: true, tiktok: false, accessStatus: "active" },
    });
  });

  it("has nothing to open for a Client that does not exist", async () => {
    const missing = await app.inject({
      method: "GET",
      url: "/api/clients/2f8c6e5a-0000-4000-8000-000000000000",
      cookies,
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toBe("client_not_found");

    // A malformed id names a Client that cannot exist either — 404, not a 500
    // from Postgres refusing the uuid.
    const malformed = await app.inject({ method: "GET", url: "/api/clients/nonsense", cookies });
    expect(malformed.statusCode).toBe(404);
  });

  it("refuses every one of these routes without a session", async () => {
    const created = await provision({ subdomain: "acme", timezone: "UTC" });
    const { id } = created.json().client;

    const unauthenticated = [
      { method: "GET" as const, url: "/api/clients" },
      { method: "GET" as const, url: `/api/clients/${id}` },
      { method: "POST" as const, url: "/api/clients", payload: { subdomain: "b", timezone: "UTC" } },
    ];

    for (const request of unauthenticated) {
      const res = await app.inject(request);
      expect(res.statusCode, `${request.method} ${request.url}`).toBe(401);
      expect(res.json()).toEqual({ error: "unauthorized" });
    }

    // Nothing leaked and nothing was written: the create was refused before its
    // body was even looked at.
    const { rows } = await db.pool.query("SELECT subdomain FROM clients");
    expect(rows).toEqual([{ subdomain: "acme" }]);
  });

  it("refuses these routes to an expired session, not merely a missing one", async () => {
    // The session dying is what makes a short TTL worth anything; an operator's
    // list of every Client on the platform must go with it.
    clock.advance(24 * 60 * 60 * 1000);

    const res = await app.inject({ method: "GET", url: "/api/clients", cookies });

    expect(res.statusCode).toBe(401);
  });

  it("provisions a Client that is then reachable at its own subdomain", async () => {
    // The point of provisioning is not the row — it is that a Client now has an
    // entry point. Only the Client-facing service can say whether it does, so
    // this asks it, on the host a browser would arrive at.
    await provision({ subdomain: "acme", timezone: "UTC" });

    const branding = await clientApp.inject({
      method: "GET",
      url: "/api/branding",
      headers: { host: clientHost("acme") },
    });

    expect(branding.statusCode).toBe(200);
    // A subdomain nobody provisioned is still nothing, so the 200 above is this
    // Client's own entry point rather than a surface that answers anyone.
    const unprovisioned = await clientApp.inject({
      method: "GET",
      url: "/api/branding",
      headers: { host: clientHost("nobody") },
    });
    expect(unprovisioned.statusCode).toBe(404);
  });
});
