/**
 * Ordered schema migrations, applied by {@link ./migrate.ts}.
 *
 * Each entry runs exactly once, tracked in `schema_migrations`. Never edit or
 * reorder an already-shipped migration — append a new one. Migrations are kept
 * as inline SQL (rather than loose `.sql` files) so they travel with the
 * compiled build and run identically in dev, test, and production.
 *
 * Slice 1 only needs enough schema to prove the walking skeleton end-to-end:
 * a value the health endpoint can read, and a record the worker can write.
 * The real domain tables (Client, User, Connected Account, Post, Target,
 * Metric Snapshot) arrive in later slices.
 */
export interface Migration {
  name: string;
  sql: string;
}

export const migrations: readonly Migration[] = [
  {
    name: "001_walking_skeleton",
    sql: /* sql */ `
      -- A single-row table the health endpoint reads to prove the API can reach Postgres.
      CREATE TABLE health_check (
        id      integer PRIMARY KEY DEFAULT 1,
        status  text NOT NULL,
        CONSTRAINT health_check_singleton CHECK (id = 1)
      );
      INSERT INTO health_check (id, status) VALUES (1, 'ok');

      -- A log of processed background jobs, written by the worker to prove the
      -- BullMQ round-trip end-to-end.
      CREATE TABLE job_runs (
        id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        job_name      text NOT NULL,
        payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
        processed_at  timestamptz NOT NULL DEFAULT now()
      );
    `,
  },
];
