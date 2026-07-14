import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import { runMigrations } from "../../src/db/migrate.js";

export interface TestPostgres {
  pool: pg.Pool;
  connectionUri: string;
  stop(): Promise<void>;
}

/**
 * Spin up an ephemeral Postgres in Docker, apply migrations, and return a pool.
 * This is the primary test seam (per the PRD): tests drive the real API against
 * a real, throwaway Postgres and assert on response + DB state.
 */
export async function startTestPostgres(): Promise<TestPostgres> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer(
    "postgres:16",
  ).start();
  const connectionUri = container.getConnectionUri();
  const pool = new pg.Pool({ connectionString: connectionUri });
  await runMigrations(pool);

  return {
    pool,
    connectionUri,
    async stop() {
      await pool.end();
      await container.stop();
    },
  };
}
