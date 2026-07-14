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
  {
    // Slice 2 — the tenancy spine: Clients, their Users, and login Sessions.
    // Plan/branding columns arrive in later slices (Plan gating is Slice 3,
    // branding Slice 5); this migration carries only what the spine needs.
    name: "002_tenancy",
    sql: /* sql */ `
      -- A Client is the unit of tenant isolation, reached at its own subdomain
      -- and anchored to a single timezone for all scheduling/analytics.
      CREATE TABLE clients (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        -- Constraint named explicitly: the provisioning code maps this exact
        -- name to a 409 "subdomain_taken", so it must not depend on Postgres's
        -- auto-generated name.
        subdomain   text NOT NULL CONSTRAINT clients_subdomain_key UNIQUE,
        timezone    text NOT NULL,
        created_at  timestamptz NOT NULL DEFAULT now()
      );

      -- A User belongs to exactly one Client. Email is globally unique across
      -- the whole platform (case-insensitive), enforced by the DB — the same
      -- email can never belong to two Clients.
      CREATE TABLE users (
        id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        client_id      uuid NOT NULL REFERENCES clients (id) ON DELETE CASCADE,
        email          text NOT NULL,
        password_hash  text NOT NULL,
        created_at     timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX users_email_unique ON users (lower(email));
      CREATE INDEX users_client_id ON users (client_id);

      -- Opaque, DB-backed login sessions. The token is the primary key; the API
      -- hands it to the SPA and looks the User up by it on each request. Being a
      -- row (not a stateless JWT) lets later slices revoke on suspension/logout.
      CREATE TABLE sessions (
        token       text PRIMARY KEY,
        user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        created_at  timestamptz NOT NULL DEFAULT now(),
        expires_at  timestamptz NOT NULL
      );
      CREATE INDEX sessions_user_id ON sessions (user_id);
    `,
  },
  {
    // Slice 3 — Plan gating. A Client's Plan is a strict 1:1 with the Client
    // (one bundle per Client), so it lives as columns on `clients` rather than
    // its own table. Three per-platform toggles gate what Users see and may act
    // on; `access_status` gates login and every action entirely. Payment is
    // manual/off-platform — the Superadmin flips these by hand (CONTEXT.md `Plan`).
    name: "003_plan_gating",
    sql: /* sql */ `
      ALTER TABLE clients
        -- Platforms are opt-in: a Client "sees and pays for what it needs", so a
        -- newly provisioned Client has none until the Superadmin enables them.
        ADD COLUMN facebook_enabled  boolean NOT NULL DEFAULT false,
        ADD COLUMN instagram_enabled boolean NOT NULL DEFAULT false,
        ADD COLUMN tiktok_enabled    boolean NOT NULL DEFAULT false,
        -- Constraint named explicitly so the update code can rely on it; access
        -- defaults to 'active' so existing Clients stay logged-in-able.
        ADD COLUMN access_status text NOT NULL DEFAULT 'active'
          CONSTRAINT clients_access_status_check
          CHECK (access_status IN ('active', 'suspended', 'expired'));
    `,
  },
];
