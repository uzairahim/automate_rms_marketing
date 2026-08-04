import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import { runAdminMigrations } from "../../src/db/migrate.js";
// A **development-only** use of the Client-facing service's migration list (PRD
// #15): the cross-surface suites need real `clients` and `users` to provision a
// Client User against. There is no runtime dependency in this direction —
// nothing under `src/` imports `@smma/server`, so the admin service stays
// independently deployable.
import { runMigrations as runClientMigrations } from "../../../server/src/db/migrate.js";

export interface TestPostgres {
  pool: pg.Pool;
  connectionUri: string;
  stop(): Promise<void>;
}

/**
 * Spin up an ephemeral Postgres in Docker, migrate it, and return a pool. The
 * admin service's seam: drive the real admin API against a real, throwaway
 * Postgres and assert on responses and resulting DB state.
 *
 * By default only the **admin** migrations are applied, which is the deployment
 * this service actually claims to support — its own tables, no Client-facing
 * schema anywhere. A suite that needs a Client to exist (cross-surface login,
 * later slices' Client fixtures) opts into the Client-facing list explicitly.
 */
export async function startTestPostgres(
  { clientSchema = false }: { clientSchema?: boolean } = {},
): Promise<TestPostgres> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer(
    "postgres:16",
  ).start();
  const connectionUri = container.getConnectionUri();
  const pool = new pg.Pool({ connectionString: connectionUri });

  await runAdminMigrations(pool);
  if (clientSchema) await runClientMigrations(pool);

  return {
    pool,
    connectionUri,
    async stop() {
      await pool.end();
      await container.stop();
    },
  };
}
