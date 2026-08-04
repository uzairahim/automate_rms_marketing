import type pg from "pg";

/**
 * The name-keyed migration runner both deployables apply their own list through
 * (ADR 0010).
 *
 * Each service owns the migrations for the tables only it reads and writes —
 * `@smma/server` owns `clients`, `users`, `posts` and the rest; `@smma/admin`
 * owns `superadmins` and `admin_sessions` under an `admin_` name prefix. The two
 * lists share this one runner and one `schema_migrations` table, which is safe
 * precisely because a Superadmin belongs to no Client: neither list carries a
 * foreign key into the other's tables, so they have nothing to order against and
 * either service can migrate an empty database by itself.
 *
 * The runner lives here rather than in either service because the tracking-table
 * semantics must be identical on both sides — two copies would eventually
 * disagree about what "already applied" means, against one shared database.
 */
export interface Migration {
  name: string;
  sql: string;
}

/**
 * A fixed key for the Postgres advisory lock the runner holds while it applies.
 * Arbitrary, but must be the same number in every process for the lock to mean
 * anything — which is the point of it being defined here, once.
 */
const MIGRATION_LOCK_KEY = 8_15_09_2026;

/**
 * Apply all pending migrations from `migrations` against the given pool.
 * Idempotent: already-applied migrations (tracked by name in `schema_migrations`)
 * are skipped. Each migration runs inside its own transaction so a failure
 * leaves the schema consistent.
 *
 * The whole run is serialized on a Postgres advisory lock, because two services
 * now migrate one database and a `docker compose up`-style cold start boots them
 * together. Without it, both could read the same empty `schema_migrations` and
 * race to apply — with the lock, the second waits and then finds nothing to do.
 */
export async function runMigrations(
  pool: pg.Pool,
  migrations: readonly Migration[],
): Promise<void> {
  const client = await pool.connect();
  try {
    // Session-level (not transaction-level): the migrations below each run in
    // their own transaction, so the lock has to outlive all of them.
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name        text PRIMARY KEY,
        applied_at  timestamptz NOT NULL DEFAULT now()
      );
    `);

    const applied = await client.query<{ name: string }>("SELECT name FROM schema_migrations");
    const appliedNames = new Set(applied.rows.map((r) => r.name));

    for (const migration of migrations) {
      if (appliedNames.has(migration.name)) continue;

      try {
        await client.query("BEGIN");
        await client.query(migration.sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [migration.name]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${migration.name} failed: ${(err as Error).message}`, {
          cause: err,
        });
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]).catch(() => {});
    client.release();
  }
}
