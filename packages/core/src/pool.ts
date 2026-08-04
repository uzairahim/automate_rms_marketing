import pg from "pg";

const { Pool } = pg;

/**
 * Reaching the shared Postgres — here for the same reason the migration runner
 * is (ADR 0010): both deployables connect to one database, so how they connect
 * to it is not something either of them owns privately.
 */

/** A Postgres connection pool. One shared pool per process. */
export function createPool(databaseUrl: string): pg.Pool {
  return new Pool({ connectionString: databaseUrl });
}

/**
 * Wait until Postgres accepts a query, retrying on connection errors. On a cold
 * `npm run dev` the processes start alongside `docker compose up`, so Postgres
 * may not be ready for the first few seconds — without this an entrypoint would
 * throw and `tsx watch` would not restart until a file changed.
 */
export async function waitForPostgres(
  pool: pg.Pool,
  { retries = 30, delayMs = 1000 }: { retries?: number; delayMs?: number } = {},
): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      await pool.query("SELECT 1");
      return;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error(
    `Postgres not reachable after ${retries} attempts: ${(lastErr as Error)?.message}`,
    { cause: lastErr },
  );
}
