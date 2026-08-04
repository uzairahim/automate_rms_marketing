import type { Migration } from "@smma/core";

/**
 * The Superadmin service's own schema — the tables only it reads and writes
 * (ADR 0010).
 *
 * Every name carries the `admin_` prefix, because these entries share one
 * `schema_migrations` table with the Client-facing service's list. Sharing the
 * tracker is safe precisely because a Superadmin belongs to no Client: nothing
 * here references `clients` or `users`, so the two lists have nothing to order
 * against and either service can migrate an empty database by itself.
 *
 * Never edit or reorder an already-shipped migration — append a new one.
 */
export const adminMigrations: readonly Migration[] = [
  {
    name: "admin_001_superadmin_identity",
    sql: /* sql */ `
      -- A Superadmin is a named person with their own credentials, not a shared
      -- secret and not a User with a null Client: it belongs to no Client at all,
      -- which is why 'users.client_id' can stay NOT NULL and no tenant-scoped
      -- query has to be re-audited for a tenant-less row.
      CREATE TABLE superadmins (
        id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        email          text NOT NULL,
        password_hash  text NOT NULL,
        created_at     timestamptz NOT NULL DEFAULT now()
      );
      -- An email is one identity however it was typed, matching how a Client's
      -- Users are keyed. Named explicitly so the upsert can target it.
      CREATE UNIQUE INDEX superadmins_email_unique ON superadmins (lower(email));

      -- Opaque, DB-backed operator sessions, separate from the Client-facing
      -- 'sessions' table so that no query can return a Superadmin where a
      -- Client's User is expected. Being a row rather than a stateless token is
      -- what lets logout and a password reset end a session immediately.
      CREATE TABLE admin_sessions (
        token          text PRIMARY KEY,
        superadmin_id  uuid NOT NULL REFERENCES superadmins (id) ON DELETE CASCADE,
        created_at     timestamptz NOT NULL DEFAULT now(),
        expires_at     timestamptz NOT NULL
      );
      CREATE INDEX admin_sessions_superadmin_id ON admin_sessions (superadmin_id);
    `,
  },
];
