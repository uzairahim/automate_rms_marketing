import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildTestAdminApp, loginAs, sessionCookie, withSession } from "./helpers/app.js";
import { startTestPostgres, type TestPostgres } from "./helpers/postgres.js";
import { TestClock } from "../src/clock.js";
import { ADMIN_SESSION_TTL_MS, upsertSuperadmin } from "../src/auth/superadmins.js";

/**
 * Superadmin identity and login — the operator's own credentials, driven
 * through the real admin API against a real, throwaway Postgres.
 *
 * The credential here can suspend every Client on the platform, so the suite
 * asserts on the properties that make that survivable: it is a person's own
 * password rather than a shared secret, the session is unreadable by page
 * scripts, it expires on its own, logging out ends it, and a Client's User can
 * never present themselves here.
 */

const EMAIL = "operator@ourapp.test";
const PASSWORD = "correct horse battery";

describe("Superadmin identity and login", () => {
  let db: TestPostgres;
  let app: FastifyInstance;
  const clock = new TestClock(new Date("2026-08-04T09:00:00.000Z"));

  beforeAll(async () => {
    // Only the admin migrations — this suite runs against the deployment the
    // service actually claims: its own two tables and no Client-facing schema
    // anywhere in the database.
    db = await startTestPostgres();
    app = buildTestAdminApp({ pool: db.pool, clock });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await db.stop();
  });

  beforeEach(async () => {
    clock.set(new Date("2026-08-04T09:00:00.000Z"));
    await db.pool.query("TRUNCATE superadmins, admin_sessions RESTART IDENTITY CASCADE");
    await upsertSuperadmin(db.pool, { email: EMAIL, password: PASSWORD });
  });

  const login = (email: string, password: string) =>
    app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });

  it("signs the operator in with their own credentials", async () => {
    const res = await login(EMAIL, PASSWORD);

    expect(res.statusCode).toBe(200);
    expect(res.json().superadmin).toMatchObject({ email: EMAIL });
    expect(res.body).not.toContain(PASSWORD);
  });

  it("keeps the operator signed in across page loads", async () => {
    const { cookies } = await loginAs(app, { email: EMAIL, password: PASSWORD });

    const me = await app.inject({ method: "GET", url: "/api/me", cookies });

    expect(me.statusCode).toBe(200);
    expect(me.json().superadmin).toMatchObject({ email: EMAIL });
  });

  it("puts the session in a cookie page scripts cannot read", async () => {
    const res = await login(EMAIL, PASSWORD);
    const cookie = sessionCookie(res);

    expect(cookie).toBeDefined();
    expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: "Strict", path: "/" });
    // The token is *only* in the cookie: a body carrying it would put the
    // platform-wide credential back within reach of an injected script.
    expect(res.body).not.toContain(cookie!.value);
  });

  it("signs in on a case-different email, since an email is one identity", async () => {
    const res = await login("Operator@OurApp.test", PASSWORD);

    expect(res.statusCode).toBe(200);
  });

  it("fails identically for a wrong password and an unknown email", async () => {
    const wrongPassword = await login(EMAIL, "not the password");
    const unknownEmail = await login("nobody@ourapp.test", PASSWORD);

    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownEmail.statusCode).toBe(401);
    // Byte-identical, so the form cannot be used to discover operator accounts.
    expect(unknownEmail.json()).toEqual(wrongPassword.json());
    expect(unknownEmail.json()).toEqual({ error: "invalid_credentials" });
    expect(sessionCookie(unknownEmail)).toBeUndefined();
  });

  it("refuses a login that is missing its credentials", async () => {
    const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: {} });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_body");
  });

  it("expires a session on its own, well before the Client's 30 days", async () => {
    const { cookies } = await loginAs(app, { email: EMAIL, password: PASSWORD });

    // An unattended browser must not stay authorized indefinitely — checked
    // against the injected clock rather than by waiting.
    clock.advance(ADMIN_SESSION_TTL_MS - 1000);
    expect((await app.inject({ method: "GET", url: "/api/me", cookies })).statusCode).toBe(200);

    clock.advance(2000);
    const after = await app.inject({ method: "GET", url: "/api/me", cookies });

    expect(after.statusCode).toBe(401);
    expect(ADMIN_SESSION_TTL_MS).toBeLessThan(30 * 24 * 60 * 60 * 1000);
  });

  it("ends the session on logout, leaving the shell unreachable", async () => {
    const { token, cookies } = await loginAs(app, { email: EMAIL, password: PASSWORD });

    const out = await app.inject({ method: "POST", url: "/api/auth/logout", cookies });
    expect(out.statusCode).toBe(204);
    // The cookie is cleared on the way out, so a shared machine keeps nothing.
    expect(sessionCookie(out)?.value).toBe("");

    expect((await app.inject({ method: "GET", url: "/api/me", cookies })).statusCode).toBe(401);
    // And the credential is dead server-side, not merely dropped by the browser.
    const { rows } = await db.pool.query("SELECT token FROM admin_sessions WHERE token = $1", [
      token,
    ]);
    expect(rows).toEqual([]);
  });

  it("treats logging out twice as no worse than logging out once", async () => {
    const { cookies } = await loginAs(app, { email: EMAIL, password: PASSWORD });

    await app.inject({ method: "POST", url: "/api/auth/logout", cookies });
    const again = await app.inject({ method: "POST", url: "/api/auth/logout", cookies });

    expect(again.statusCode).toBe(204);
  });

  it("refuses a request with no session at all, and one with an invented token", async () => {
    expect((await app.inject({ method: "GET", url: "/api/me" })).statusCode).toBe(401);

    const invented = await app.inject({
      method: "GET",
      url: "/api/me",
      cookies: withSession("not-a-real-token"),
    });
    expect(invented.statusCode).toBe(401);
    expect(invented.json()).toEqual({ error: "unauthorized" });
  });

});
