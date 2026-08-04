import pg from "pg";

const { Pool } = pg;

/** A Postgres connection pool — one per process. */
export function createPool(databaseUrl: string): pg.Pool {
  return new Pool({ connectionString: databaseUrl });
}

/**
 * Wait until Postgres accepts a query, retrying on connection errors. The admin
 * stack starts alongside `docker compose up` in local dev, so Postgres may not
 * be ready for the first few seconds — without this the entrypoint would throw
 * and `tsx watch` would not restart until a file changed.
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
