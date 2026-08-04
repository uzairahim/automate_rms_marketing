import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildTestApp, TEST_BASE_DOMAIN } from "./helpers/app.js";
import { startTestPostgres, type TestPostgres } from "./helpers/postgres.js";
import { seed, seedOptionsFromEnv, DEFAULT_SEED, type SeedOptions } from "../src/db/seed.js";
import { createClient, createUser, ProvisionError } from "@smma/core";

/**
 * The development seeder.
 *
 * Tested through the same door a developer uses it: seed, then actually *log in*
 * with the credentials it claims to have made. Asserting on rows would prove the
 * writes happened without proving the thing anyone cares about — that
 * `npm run seed` hands you a working login.
 *
 * Idempotence is the other half. A seeder that only works against an empty
 * database gets run once and then avoided, so re-running is exercised directly.
 */

const host = (subdomain: string) => `${subdomain}.${TEST_BASE_DOMAIN}`;

describe("Development seeder", () => {
  let db: TestPostgres;
  let app: FastifyInstance;

  beforeAll(async () => {
    db = await startTestPostgres();
    app = buildTestApp({ pool: db.pool });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await db.stop();
  });

  beforeEach(async () => {
    await db.pool.query("TRUNCATE clients, users, sessions RESTART IDENTITY CASCADE");
  });

  /** Log in exactly as the SPA does, on the seeded Client's subdomain. */
  const login = (subdomain: string, email: string, password: string) =>
    app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { host: host(subdomain) },
      payload: { email, password },
    });

  it("seeds a Client and a User who can actually sign in", async () => {
    const result = await seed(db.pool);

    expect(result.client).toMatchObject({ subdomain: "acme", created: true });
    expect(result.user).toMatchObject({ email: "admin@test.com", created: true });

    const res = await login("acme", "admin@test.com", "Abcd_1234");
    expect(res.statusCode).toBe(200);
    expect(res.json().user.email).toBe("admin@test.com");
  });

  it("enables every platform, so a seeded Client can exercise any of them", async () => {
    await seed(db.pool);

    const res = await login("acme", "admin@test.com", "Abcd_1234");
    expect(res.json().client.plan).toMatchObject({
      facebook: true,
      instagram: true,
      tiktok: true,
      accessStatus: "active",
    });
  });

  it("is idempotent — a second run neither fails nor duplicates", async () => {
    const first = await seed(db.pool);
    const second = await seed(db.pool);

    expect(second.client.created).toBe(false);
    expect(second.user.created).toBe(false);
    expect(second.client.id).toBe(first.client.id);
    expect(second.user.id).toBe(first.user.id);

    const { rows } = await db.pool.query<{ count: string }>(
      "SELECT count(*) FROM users WHERE email = $1",
      ["admin@test.com"],
    );
    expect(rows[0]!.count).toBe("1");

    expect((await login("acme", "admin@test.com", "Abcd_1234")).statusCode).toBe(200);
  });

  it("resets a changed password back to the seed value", async () => {
    await seed(db.pool);
    // Whatever the dev did to it since — a reset flow, a Superadmin set.
    await db.pool.query("UPDATE users SET password_hash = 'not-a-usable-hash' WHERE email = $1", [
      "admin@test.com",
    ]);
    expect((await login("acme", "admin@test.com", "Abcd_1234")).statusCode).toBe(401);

    await seed(db.pool);

    expect((await login("acme", "admin@test.com", "Abcd_1234")).statusCode).toBe(200);
  });

  it("adopts a Client that already exists rather than failing on its subdomain", async () => {
    const existing = await createClient(db.pool, {
      subdomain: "acme",
      timezone: "Europe/Lisbon",
      plan: { facebook: true },
    });

    const result = await seed(db.pool);

    expect(result.client).toMatchObject({ id: existing.id, created: false });
    expect(result.user.created).toBe(true);
    // The existing Client is adopted as it is — the seeder does not quietly
    // rewrite a timezone or Plan someone deliberately set.
    const res = await login("acme", "admin@test.com", "Abcd_1234");
    expect(res.json().client.timezone).toBe("Europe/Lisbon");
  });

  it("refuses to hijack an email that belongs to a different Client", async () => {
    // An email is globally unique platform-wide, so the seed address may already
    // be someone else's login. Resetting its password would hand over an account
    // the seeder does not own.
    const other = await createClient(db.pool, { subdomain: "globex", timezone: "UTC" });
    await createUser(db.pool, {
      clientId: other.id,
      email: "admin@test.com",
      password: "their own password",
    });

    await expect(seed(db.pool)).rejects.toBeInstanceOf(ProvisionError);
    // And the other Client's User is left exactly as it was.
    expect((await login("globex", "admin@test.com", "their own password")).statusCode).toBe(200);
  });

  it("honours overrides, so a second dev login can be seeded alongside", async () => {
    const options: SeedOptions = {
      ...DEFAULT_SEED,
      subdomain: "globex",
      email: "second@test.com",
      password: "Abcd_1234",
      timezone: "Asia/Karachi",
    };

    await seed(db.pool, DEFAULT_SEED);
    const result = await seed(db.pool, options);

    expect(result.client.subdomain).toBe("globex");
    const res = await login("globex", "second@test.com", "Abcd_1234");
    expect(res.statusCode).toBe(200);
    expect(res.json().client.timezone).toBe("Asia/Karachi");
    // The default seed is untouched — the two coexist.
    expect((await login("acme", "admin@test.com", "Abcd_1234")).statusCode).toBe(200);
  });

  describe("seedOptionsFromEnv", () => {
    it("defaults to the documented dev login", () => {
      expect(seedOptionsFromEnv({})).toMatchObject({
        subdomain: "acme",
        email: "admin@test.com",
        password: "Abcd_1234",
      });
    });

    it("takes each override from the environment", () => {
      expect(
        seedOptionsFromEnv({
          SEED_SUBDOMAIN: "globex",
          SEED_EMAIL: "dev@example.com",
          SEED_PASSWORD: "another password",
          SEED_TIMEZONE: "Asia/Karachi",
        }),
      ).toMatchObject({
        subdomain: "globex",
        email: "dev@example.com",
        password: "another password",
        timezone: "Asia/Karachi",
      });
    });
  });
});
