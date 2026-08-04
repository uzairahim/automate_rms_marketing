import pg from "pg";
import {
  createClient,
  createUser,
  findClientBySubdomain,
  isMainModule,
  ProvisionError,
  setUserPassword,
  type PlanPatch,
} from "@smma/core";

/**
 * Seed a development login.
 *
 * There is no self-signup on this platform — a User is provisioned by the
 * Superadmin and belongs to exactly one Client (CONTEXT.md `User`). So "seed a
 * user" necessarily means "seed a Client and a User inside it": a User with no
 * Client has no subdomain to log in at and no Plan to act under.
 *
 * Idempotent by design, because a seeder that only works on an empty database is
 * a seeder people stop running. Re-seeding reuses the Client, and resets the
 * User's password back to the seed value — so `npm run seed` is always a way to
 * recover a known-good login, not just a first-run step.
 */

export interface SeedOptions {
  subdomain: string;
  timezone: string;
  email: string;
  password: string;
  /** Which platforms the seeded Client may use. All three, so dev can exercise any. */
  plan: PlanPatch;
}

export const DEFAULT_SEED: SeedOptions = {
  subdomain: "acme",
  timezone: "America/New_York",
  email: "admin@test.com",
  password: "Abcd_1234",
  plan: { facebook: true, instagram: true, tiktok: true },
};

export interface SeedResult {
  client: { id: string; subdomain: string; created: boolean };
  user: { id: string; email: string; created: boolean };
}

/** The seeded User's id and Client, or null if that email is not in use at all. */
async function findUserByEmail(
  pool: pg.Pool,
  email: string,
): Promise<{ id: string; clientId: string } | null> {
  // Read directly rather than through the tenancy module: nothing in the app
  // looks a User up by email outside of login (which needs the hash too), and
  // the seeder only wants the id so it can reset the password.
  const { rows } = await pool.query<{ id: string; client_id: string }>(
    `SELECT id, client_id FROM users WHERE email = $1`,
    [email.trim().toLowerCase()],
  );
  const row = rows[0];
  return row ? { id: row.id, clientId: row.client_id } : null;
}

export async function seed(
  pool: pg.Pool,
  options: SeedOptions = DEFAULT_SEED,
): Promise<SeedResult> {
  const subdomain = options.subdomain.trim().toLowerCase();
  const email = options.email.trim().toLowerCase();

  // Reuse an existing Client rather than failing on `subdomain_taken`: the
  // common case for a re-seed is a database that already has it.
  const existingClient = await findClientBySubdomain(pool, subdomain);
  const client =
    existingClient ??
    (await createClient(pool, { subdomain, timezone: options.timezone, plan: options.plan }));

  const existingUser = await findUserByEmail(pool, email);

  if (existingUser) {
    // An email is globally unique across the whole platform (CONTEXT.md `User`),
    // so this address may belong to a different Client entirely. Resetting its
    // password would hand over a login the seeder does not own — refuse loudly
    // instead, and name the fix.
    if (existingUser.clientId !== client.id) {
      throw new ProvisionError(
        "email_taken",
        `${email} already belongs to a different Client. Seed a different email ` +
          `(SEED_EMAIL=...), or remove that User first.`,
      );
    }

    // Same Client: put the password back to the seed value, so a forgotten or
    // changed dev password is one `npm run seed` away from working again.
    await setUserPassword(pool, { userId: existingUser.id, password: options.password });
    return {
      client: { id: client.id, subdomain: client.subdomain, created: !existingClient },
      user: { id: existingUser.id, email, created: false },
    };
  }

  const user = await createUser(pool, { clientId: client.id, email, password: options.password });
  return {
    client: { id: client.id, subdomain: client.subdomain, created: !existingClient },
    user: { id: user.id, email: user.email, created: true },
  };
}

/** Seed options from the environment, falling back to {@link DEFAULT_SEED}. */
export function seedOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): SeedOptions {
  return {
    subdomain: env.SEED_SUBDOMAIN ?? DEFAULT_SEED.subdomain,
    timezone: env.SEED_TIMEZONE ?? DEFAULT_SEED.timezone,
    email: env.SEED_EMAIL ?? DEFAULT_SEED.email,
    password: env.SEED_PASSWORD ?? DEFAULT_SEED.password,
    plan: DEFAULT_SEED.plan,
  };
}

// CLI entrypoint: `npm run seed`.
if (isMainModule(import.meta.url)) {
  const { waitForPostgres } = await import("./pool.js");
  const { runMigrations } = await import("./migrate.js");
  await import("../load-env.js");

  // This plants a login whose password is written down in this file. That is
  // exactly right for development and exactly wrong for production, so it is
  // refused there unless someone says otherwise in so many words.
  if (process.env.NODE_ENV === "production" && process.env.SEED_ALLOW_PRODUCTION !== "true") {
    console.error(
      "Refusing to seed with NODE_ENV=production — this creates a User with a known " +
        "password. Set SEED_ALLOW_PRODUCTION=true if you really mean it.",
    );
    process.exit(1);
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }

  const options = seedOptionsFromEnv();
  const pool = new pg.Pool({ connectionString: databaseUrl });

  waitForPostgres(pool)
    // Seeding a database with no schema is a confusing failure; migrations are
    // idempotent, so running them first costs nothing and makes `npm run seed`
    // work on a completely fresh checkout.
    .then(() => runMigrations(pool))
    .then(() => seed(pool, options))
    .then((result) => {
      const baseDomain = process.env.BASE_DOMAIN ?? "localhost";
      console.log(
        `Client ${result.client.subdomain} ${result.client.created ? "created" : "already existed"}.`,
      );
      console.log(
        `User ${result.user.email} ${result.user.created ? "created" : "already existed — password reset"}.`,
      );
      console.log(`\nSign in at http://${result.client.subdomain}.${baseDomain}:5173`);
      console.log(`  email:    ${options.email}`);
      console.log(`  password: ${options.password}`);
      return pool.end();
    })
    .catch((err) => {
      console.error(err instanceof ProvisionError ? `${err.code}: ${err.message}` : err);
      return pool.end().finally(() => process.exit(1));
    });
}
