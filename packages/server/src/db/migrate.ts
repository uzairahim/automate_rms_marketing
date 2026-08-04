import pg from "pg";
import { isMainModule, runMigrations as applyMigrations, waitForPostgres } from "@smma/core";
import { migrations } from "./migrations.js";

/**
 * Apply all pending Client-facing migrations against the given pool.
 *
 * The runner itself lives in `@smma/core` (ADR 0010), because the Superadmin
 * service applies its own list through the same one against the same
 * `schema_migrations` table. This is the Client-facing service's list, and the
 * only thing a caller here should have to name.
 *
 * Used by the CLI entrypoint below, the API/worker entrypoints, and by the test
 * harness to prepare each ephemeral Postgres.
 */
export async function runMigrations(pool: pg.Pool): Promise<void> {
  await applyMigrations(pool, migrations);
}

// CLI entrypoint: `npm -w @smma/server run migrate`.
if (isMainModule(import.meta.url)) {
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
