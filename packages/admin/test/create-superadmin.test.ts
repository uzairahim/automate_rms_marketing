import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { ProvisionError } from "@smma/core";
import { buildTestAdminApp, loginAs, withSession } from "./helpers/app.js";
import { startTestPostgres, type TestPostgres } from "./helpers/postgres.js";
import { createSuperadminArgs, runCreateSuperadmin } from "../src/create-superadmin.js";

/**
 * The `create-superadmin` CLI — how the platform gets its first operator, and
 * how a locked-out one gets back in.
 *
 * Tested through the door an operator uses it: run the CLI, then actually *log
 * in* with the credentials it claims to have made. Asserting on rows would prove
 * the write happened without proving the thing anyone cares about.
 *
 * This suite runs against a database carrying **only** the admin migrations, so
 * it also stands as the proof that the service migrates and works alone — no
 * Client-facing schema, no Client-facing service ever deployed against it.
 */

const EMAIL = "operator@ourapp.test";
const PASSWORD = "correct horse battery";

/** The CLI with its prompts answered — what an operator typing at a TTY does. */
const answering = (email: string, password: string) => ({
  readEmail: async () => email,
  readPassword: async () => password,
});

describe("create-superadmin", () => {
  let db: TestPostgres;
  let app: FastifyInstance;

  beforeAll(async () => {
    db = await startTestPostgres();
    app = buildTestAdminApp({ pool: db.pool });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await db.stop();
  });

  beforeEach(async () => {
    await db.pool.query("TRUNCATE superadmins, admin_sessions RESTART IDENTITY CASCADE");
  });

  const login = (email: string, password: string) =>
    app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });

  it("creates an operator who can actually sign in", async () => {
    const result = await runCreateSuperadmin(db.pool, answering(EMAIL, PASSWORD));

    expect(result).toMatchObject({ email: EMAIL, created: true });
    const res = await login(EMAIL, PASSWORD);
    expect(res.statusCode).toBe(200);
    expect(res.json().superadmin).toMatchObject({ email: EMAIL });
  });

  it("works on a database that has only ever seen the admin migrations", async () => {
    // The whole point of a separate deployable: no `clients`, no `users`, no
    // Client-facing service ever pointed at this database.
    const { rows } = await db.pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
    );
    const tables = rows.map((r) => r.table_name).sort();
    expect(tables).toEqual(["admin_sessions", "schema_migrations", "superadmins"]);

    await runCreateSuperadmin(db.pool, answering(EMAIL, PASSWORD));
    expect((await login(EMAIL, PASSWORD)).statusCode).toBe(200);
  });

  it("resets the password when re-run for the same email — the way back in", async () => {
    await runCreateSuperadmin(db.pool, answering(EMAIL, PASSWORD));

    const again = await runCreateSuperadmin(db.pool, answering(EMAIL, "a brand new password"));

    expect(again).toMatchObject({ email: EMAIL, created: false });
    expect((await login(EMAIL, "a brand new password")).statusCode).toBe(200);
    expect((await login(EMAIL, PASSWORD)).statusCode).toBe(401);
  });

  it("is idempotent — a re-run keeps one account, not two", async () => {
    const first = await runCreateSuperadmin(db.pool, answering(EMAIL, PASSWORD));
    const second = await runCreateSuperadmin(db.pool, answering(EMAIL, PASSWORD));

    expect(second.id).toBe(first.id);
    const { rows } = await db.pool.query<{ count: string }>("SELECT count(*) FROM superadmins");
    expect(rows[0]!.count).toBe("1");
  });

  it("ends the operator's live sessions when it resets their password", async () => {
    await runCreateSuperadmin(db.pool, answering(EMAIL, PASSWORD));
    const { cookies } = await loginAs(app, { email: EMAIL, password: PASSWORD });
    expect((await app.inject({ method: "GET", url: "/api/me", cookies })).statusCode).toBe(200);

    // Recovering a lost password must not leave whoever had the old one signed in.
    await runCreateSuperadmin(db.pool, answering(EMAIL, "a brand new password"));

    expect((await app.inject({ method: "GET", url: "/api/me", cookies })).statusCode).toBe(401);
  });

  it("normalizes the email, so the account is one identity however it was typed", async () => {
    await runCreateSuperadmin(db.pool, answering("  Operator@OurApp.test  ", PASSWORD));

    expect((await login(EMAIL, PASSWORD)).statusCode).toBe(200);
  });

  it("refuses a malformed email and a password too weak to hold the platform", async () => {
    await expect(runCreateSuperadmin(db.pool, answering("not-an-email", PASSWORD))).rejects
      .toBeInstanceOf(ProvisionError);
    await expect(runCreateSuperadmin(db.pool, answering(EMAIL, "short"))).rejects.toBeInstanceOf(
      ProvisionError,
    );

    const { rows } = await db.pool.query("SELECT id FROM superadmins");
    expect(rows).toEqual([]);
  });

  it("refuses a session cookie minted for an account that no longer exists", async () => {
    await runCreateSuperadmin(db.pool, answering(EMAIL, PASSWORD));
    const { token } = await loginAs(app, { email: EMAIL, password: PASSWORD });

    await db.pool.query("DELETE FROM superadmins WHERE email = $1", [EMAIL]);

    const res = await app.inject({ method: "GET", url: "/api/me", cookies: withSession(token) });
    expect(res.statusCode).toBe(401);
  });

  describe("its command line", () => {
    it("takes the email as an argument, so a re-run is one line", () => {
      expect(createSuperadminArgs(["operator@ourapp.test"])).toEqual({
        email: "operator@ourapp.test",
      });
      expect(createSuperadminArgs([])).toEqual({});
    });

    it("never takes the password as an argument, where a shell would record it", () => {
      expect(() => createSuperadminArgs(["operator@ourapp.test", "correct horse battery"])).toThrow(
        /password/i,
      );
    });
  });
});
