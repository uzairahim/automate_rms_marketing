import pg from "pg";
import { isMainModule, runMigrations, waitForPostgres } from "@smma/core";
import { adminMigrations } from "./migrations.js";

/**
 * Apply the Superadmin service's own migrations. Idempotent, and independent of
 * the Client-facing service's list: this may be the only list a given database
 * has ever seen (ADR 0010).
 *
 * Called on boot by {@link ../api.ts} — the admin service stands itself up
 * against a database rather than waiting for anything else to be deployed first.
 */
export async function runAdminMigrations(pool: pg.Pool): Promise<void> {
  await runMigrations(pool, adminMigrations);
}

// CLI entrypoint: `npm -w @smma/admin run migrate`.
if (isMainModule(import.meta.url)) {
  await import("../load-env.js");
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }
  const pool = new pg.Pool({ connectionString: databaseUrl });
  waitForPostgres(pool)
    .then(() => runAdminMigrations(pool))
    .then(() => {
      console.log("Admin migrations applied.");
      return pool.end();
    })
    .catch((err) => {
      console.error(err);
      return pool.end().finally(() => process.exit(1));
    });
}
