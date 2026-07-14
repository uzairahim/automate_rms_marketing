import pg from "pg";
import { migrations } from "./migrations.js";

/**
 * Apply all pending migrations against the given pool. Idempotent: already-applied
 * migrations (tracked in `schema_migrations`) are skipped. Each migration runs
 * inside its own transaction so a failure leaves the schema consistent.
 *
 * Used by the CLI entrypoint below, and by the test harness to prepare each
 * ephemeral Postgres.
 */
export async function runMigrations(pool: pg.Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        text PRIMARY KEY,
      applied_at  timestamptz NOT NULL DEFAULT now()
    );
  `);

  const applied = await pool.query<{ name: string }>(
    "SELECT name FROM schema_migrations",
  );
  const appliedNames = new Set(applied.rows.map((r) => r.name));

  for (const migration of migrations) {
    if (appliedNames.has(migration.name)) continue;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(migration.sql);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [
        migration.name,
      ]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw new Error(
        `Migration ${migration.name} failed: ${(err as Error).message}`,
        { cause: err },
      );
    } finally {
      client.release();
    }
  }
}

// CLI entrypoint: `npm -w @smma/server run migrate`.
if (import.meta.url === `file://${process.argv[1]}`) {
  const { waitForPostgres } = await import("./pool.js");
  await import("../load-env.js");
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }
  const pool = new pg.Pool({ connectionString: databaseUrl });
  waitForPostgres(pool)
    .then(() => runMigrations(pool))
    .then(() => {
      console.log("Migrations applied.");
      return pool.end();
    })
    .catch((err) => {
      console.error(err);
      return pool.end().finally(() => process.exit(1));
    });
}
