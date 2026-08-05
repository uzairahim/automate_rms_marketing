import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { createClient, createUser } from "@smma/core";
import { buildTestAdminApp, loginAs, withSession } from "./helpers/app.js";
import { startTestPostgres, type TestPostgres } from "./helpers/postgres.js";
import { buildTestClientApp, clientHost } from "./helpers/client-app.js";
import { TestClock } from "../src/clock.js";
import { upsertSuperadmin } from "../src/auth/superadmins.js";

/**
 * The two identities never meet (CONTEXT.md `Superadmin`).
 *
 * Both services are built here against one database — which is the only place
 * this can be shown, since each direction of the rule is enforced by the surface
 * the credential is *not* meant for. A Superadmin who could log into a Client
 * would be a tenant with global powers; a Client User who could log into the
 * admin panel would be a tenant who could suspend every other one.
 */

const OPERATOR_EMAIL = "operator@ourapp.test";
const OPERATOR_PASSWORD = "correct horse battery";
const USER_EMAIL = "user@acme.test";
const USER_PASSWORD = "their own password";

describe("Cross-surface isolation between a Superadmin and a Client's User", () => {
  let db: TestPostgres;
  let adminApp: FastifyInstance;
  let clientApp: FastifyInstance;
  const clock = new TestClock(new Date("2026-08-04T09:00:00.000Z"));

  beforeAll(async () => {
    db = await startTestPostgres({ clientSchema: true });
    adminApp = buildTestAdminApp({ pool: db.pool, clock });
    clientApp = buildTestClientApp({ pool: db.pool, clock });
    await Promise.all([adminApp.ready(), clientApp.ready()]);
  });

  afterAll(async () => {
    await Promise.all([adminApp.close(), clientApp.close()]);
    await db.stop();
  });

  beforeEach(async () => {
    clock.set(new Date("2026-08-04T09:00:00.000Z"));
    await db.pool.query("TRUNCATE superadmins, admin_sessions RESTART IDENTITY CASCADE");
    await db.pool.query("TRUNCATE clients, users, sessions RESTART IDENTITY CASCADE");

    await upsertSuperadmin(db.pool, { email: OPERATOR_EMAIL, password: OPERATOR_PASSWORD });
    const client = await createClient(db.pool, { subdomain: "acme", timezone: "UTC" });
    await createUser(db.pool, {
      clientId: client.id,
      email: USER_EMAIL,
      password: USER_PASSWORD,
    });
  });

  const clientLogin = (email: string, password: string) =>
    clientApp.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { host: clientHost("acme") },
      payload: { email, password },
    });

  const adminLogin = (email: string, password: string) =>
    adminApp.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });

  it("refuses a Superadmin's credentials on a Client's subdomain", async () => {
    const res = await clientLogin(OPERATOR_EMAIL, OPERATOR_PASSWORD);

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "invalid_credentials" });
    // Nothing was opened — not even a session belonging to no one.
    const { rows } = await db.pool.query("SELECT token FROM sessions");
    expect(rows).toEqual([]);
  });

  it("refuses a Client User's credentials on the admin surface", async () => {
    const res = await adminLogin(USER_EMAIL, USER_PASSWORD);

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "invalid_credentials" });
    const { rows } = await db.pool.query("SELECT token FROM admin_sessions");
    expect(rows).toEqual([]);
  });

  it("does not accept a live admin session as a Client's bearer token", async () => {
    const { token } = await loginAs(adminApp, {
      email: OPERATOR_EMAIL,
      password: OPERATOR_PASSWORD,
    });

    const res = await clientApp.inject({
      method: "GET",
      url: "/api/me",
      headers: { host: clientHost("acme"), authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(401);
  });

  it("does not accept a live Client session as an admin session", async () => {
    const login = await clientLogin(USER_EMAIL, USER_PASSWORD);
    expect(login.statusCode).toBe(200);
    const token = login.json().token as string;

    const res = await adminApp.inject({
      method: "GET",
      url: "/api/me",
      cookies: withSession(token),
    });

    expect(res.statusCode).toBe(401);
  });

  it("still signs each identity in on its own surface", async () => {
    // The isolation above must be isolation, not two broken login routes.
    expect((await adminLogin(OPERATOR_EMAIL, OPERATOR_PASSWORD)).statusCode).toBe(200);
    expect((await clientLogin(USER_EMAIL, USER_PASSWORD)).statusCode).toBe(200);
  });
});
