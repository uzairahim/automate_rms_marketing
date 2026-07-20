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
  {
    // Slice 4 — self-service password reset. A User who forgets their password
    // requests an expiring link by email; completing it sets a new password.
    // The raw token travels in the emailed link and is never stored — we keep
    // only its SHA-256 hash, so a database dump can't be used to seize accounts
    // (unlike a session token, a reset token is exposed in transit over email).
    // A token is single-use: `consumed_at` is stamped the moment it succeeds,
    // and `expires_at` bounds its lifetime; both are checked against the Clock.
    name: "004_password_reset_tokens",
    sql: /* sql */ `
      CREATE TABLE password_reset_tokens (
        token_hash   text PRIMARY KEY,
        user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        created_at   timestamptz NOT NULL DEFAULT now(),
        expires_at   timestamptz NOT NULL,
        consumed_at  timestamptz
      );
      CREATE INDEX password_reset_tokens_user_id ON password_reset_tokens (user_id);
    `,
  },
  {
    // Slice 5 — light white-label branding. A Client's branding (logo, primary
    // color, app display name) is a strict 1:1 with the Client, so it lives as
    // columns on `clients` alongside the Plan. All three are nullable: NULL means
    // "no custom value set", and the read path falls back to a neutral default
    // that mentions no operator (CONTEXT.md `Client`, `Superadmin`). The SPA
    // resolves branding from the subdomain and fetches it at load.
    name: "005_client_branding",
    sql: /* sql */ `
      ALTER TABLE clients
        ADD COLUMN app_name       text,
        -- The DB is the source of truth for the stored form: a non-null color is
        -- a normalized #rrggbb hex (mirrors the access_status CHECK). NULL — the
        -- "unset, use default" state — is allowed through.
        ADD COLUMN primary_color  text
          CONSTRAINT clients_primary_color_check
          CHECK (primary_color IS NULL OR primary_color ~ '^#[0-9a-f]{6}$'),
        ADD COLUMN logo_url       text;
    `,
  },
  {
    // Slice 6 — Connected Accounts and the OAuth handshake that creates them.
    //
    // A Connected Account is a social destination a Client has linked. Tokens
    // are the crown jewels, so `credential` holds an AES-256-GCM blob whose key
    // lives outside this database (ADR 0006) — nothing here is queryable by
    // token value, which is never needed.
    name: "006_connected_accounts",
    sql: /* sql */ `
      CREATE TABLE connected_accounts (
        id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        client_id     uuid NOT NULL REFERENCES clients (id) ON DELETE CASCADE,
        platform      text NOT NULL
          CONSTRAINT connected_accounts_platform_check
          CHECK (platform IN ('facebook', 'instagram', 'tiktok')),

        -- 'disconnected' is a state, not a deleted row: the row is the Client's
        -- one slot per platform, so reconnecting reuses it (and the credential
        -- is nulled on the way out, never left lying around).
        status        text NOT NULL DEFAULT 'connected'
          CONSTRAINT connected_accounts_status_check
          CHECK (status IN ('connected', 'disconnected', 'token_expired')),

        -- The platform's id for the destination itself: a Page id, never a
        -- personal profile id (ADR 0005). Null only while disconnected.
        external_id       text,
        display_name      text,
        -- The platform's id for the *person* who authorized. A Meta
        -- deauthorization callback names this, not the Page.
        platform_user_id  text,

        credential        text,
        -- Null when the platform does not tell us, or for a hand-pasted token
        -- (ADR 0008). The refresh job only considers rows that have one.
        token_expires_at  timestamptz,
        -- False for a hand-pasted long-lived token (ADR 0008): it cannot be
        -- auto-refreshed and must be regenerated by a human.
        refreshable       boolean NOT NULL DEFAULT true,

        connected_at      timestamptz,
        updated_at        timestamptz NOT NULL DEFAULT now(),

        -- At most one account per platform per Client (CONTEXT.md 'Client'), so
        -- composing stays three toggles. Enforced by the DB, not by a
        -- check-then-insert race.
        CONSTRAINT connected_accounts_client_platform_key UNIQUE (client_id, platform)
      );
      CREATE INDEX connected_accounts_client_id ON connected_accounts (client_id);
      -- The deauthorization callback's lookup: "whose accounts did this person
      -- authorize?" Partial, because only live rows can be disconnected.
      CREATE INDEX connected_accounts_platform_user_id
        ON connected_accounts (platform, platform_user_id)
        WHERE platform_user_id IS NOT NULL;
      -- The token-refresh job's due-query, mirroring the scheduler's "query for
      -- due work" approach rather than holding timers in memory.
      CREATE INDEX connected_accounts_token_expires_at
        ON connected_accounts (token_expires_at)
        WHERE status = 'connected' AND refreshable AND token_expires_at IS NOT NULL;

      -- An in-flight OAuth handshake. The state parameter is the only thing that
      -- survives the round-trip through the platform, so it carries the tenant
      -- and User the callback belongs to — the callback is never trusted to name
      -- its own Client — and doubles as CSRF protection.
      CREATE TABLE oauth_states (
        state       text PRIMARY KEY,
        client_id   uuid NOT NULL REFERENCES clients (id) ON DELETE CASCADE,
        user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        platform    text NOT NULL
          CONSTRAINT oauth_states_platform_check
          CHECK (platform IN ('facebook', 'instagram', 'tiktok')),
        -- The user token obtained at callback, encrypted, held only until the
        -- User picks a Page. Null between the start and the callback.
        credential  text,
        created_at  timestamptz NOT NULL DEFAULT now(),
        expires_at  timestamptz NOT NULL
      );
      CREATE INDEX oauth_states_client_id ON oauth_states (client_id);
    `,
  },
  {
    // Slice 8 — compose, validate-and-gate, and immediate publish.
    //
    // A Post is authored once and fans out to one Target per selected platform
    // (CONTEXT.md 'Post', 'Target'). `status` carries the full vocabulary the PRD
    // names for a Post up front — Draft/Scheduled arrive with Slice 10's
    // scheduler, but the CHECK is defined once here rather than altered later.
    //
    // A Target's own lifecycle is smaller: `pending` until it has a terminal
    // outcome, then `published` or `failed`. `retry_count`/`next_retry_at` drive
    // the 2x-at-1-minute auto-retry, found by querying "due" each tick — the same
    // no-timers-in-memory approach as the token-refresh job.
    name: "007_posts_and_targets",
    sql: /* sql */ `
      CREATE TABLE posts (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        client_id   uuid NOT NULL REFERENCES clients (id) ON DELETE CASCADE,
        author_id   uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        text        text NOT NULL DEFAULT '',
        -- The attached Media's public URL and kind. Both null together (text-only)
        -- or both set — a Post never has one without the other. Full upload/serve/
        -- purge lifecycle (ADR 0003) is Slice 9; for now this is simply what a
        -- Target is told to publish.
        media_url   text,
        media_type  text CHECK (media_type IN ('image', 'video')),
        CONSTRAINT posts_media_paired_check
          CHECK ((media_url IS NULL) = (media_type IS NULL)),
        status      text NOT NULL DEFAULT 'draft'
          CONSTRAINT posts_status_check
          CHECK (status IN
            ('draft', 'scheduled', 'publishing', 'published', 'partially_published', 'failed')),
        created_at  timestamptz NOT NULL DEFAULT now(),
        updated_at  timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX posts_client_id ON posts (client_id);

      CREATE TABLE targets (
        id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        post_id        uuid NOT NULL REFERENCES posts (id) ON DELETE CASCADE,
        platform       text NOT NULL
          CONSTRAINT targets_platform_check
          CHECK (platform IN ('facebook', 'instagram', 'tiktok')),
        status         text NOT NULL DEFAULT 'pending'
          CONSTRAINT targets_status_check
          CHECK (status IN ('pending', 'published', 'failed')),
        -- The platform's durable post/media id and permalink, persisted only on
        -- success (PRD story 46 reads the id back later for a history thumbnail).
        external_id    text,
        permalink      text,
        -- The most recent attempt's failure reason, surfaced for a manual retry.
        -- Cleared on success; kept (not appended) on repeated failure, since only
        -- the latest reason is ever shown.
        error          text,
        -- How many *auto* retries have already run (0, 1, or 2 — never more: the
        -- PRD caps auto-retry at two, then leaves the Target for a manual one).
        retry_count    integer NOT NULL DEFAULT 0,
        -- When the next auto-retry is due. Null once terminal (published/failed)
        -- or before any failure has happened yet.
        next_retry_at  timestamptz,
        updated_at     timestamptz NOT NULL DEFAULT now(),
        -- One Target per platform per Post — the fan-out is exactly the selected
        -- platform set, never duplicated.
        CONSTRAINT targets_post_platform_key UNIQUE (post_id, platform)
      );
      CREATE INDEX targets_post_id ON targets (post_id);
      -- The retry job's due-query: only a pending Target with a scheduled retry
      -- can ever be due, mirroring connected_accounts_token_expires_at.
      CREATE INDEX targets_next_retry_at
        ON targets (next_retry_at)
        WHERE status = 'pending' AND next_retry_at IS NOT NULL;
    `,
  },
  {
    // Slice 9 — Media lifecycle (ADR 0003). Uploaded image/video lives on this
    // server's disk only as long as publishing needs it, served over HTTPS so
    // Meta/TikTok can fetch it by public URL. `status`/`purge_at` carry the
    // retention rule: 'active' with a null `purge_at` until every Target
    // settles, then either purged immediately (all Published) or scheduled 24h
    // out (a partial/total failure, so the User can manually retry first).
    //
    // `posts.media_id` links a Post to the Media it was composed with — kept
    // alongside the existing `media_url`/`media_type` snapshot (unchanged, still
    // what a Target is told to publish) so the purge job can find "which Media
    // does this Post's Target set gate" without parsing the snapshot URL.
    name: "008_media",
    sql: /* sql */ `
      CREATE TABLE media (
        id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        client_id     uuid NOT NULL REFERENCES clients (id) ON DELETE CASCADE,
        type          text NOT NULL CHECK (type IN ('image', 'video')),
        -- Filename on disk under the server's configured media directory.
        storage_key   text NOT NULL,
        content_type  text NOT NULL,
        byte_size     bigint NOT NULL,
        status        text NOT NULL DEFAULT 'active'
          CONSTRAINT media_status_check CHECK (status IN ('active', 'purged')),
        -- When this Media is due to be purged. Null while unattached or still
        -- awaiting a terminal Target outcome; set only once every Target of the
        -- attached Post is terminal — never on first success (ADR 0003).
        purge_at      timestamptz,
        created_at    timestamptz NOT NULL DEFAULT now(),
        updated_at    timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX media_client_id ON media (client_id);
      -- The purge job's due-query, mirroring targets_next_retry_at's approach.
      CREATE INDEX media_purge_at
        ON media (purge_at)
        WHERE status = 'active' AND purge_at IS NOT NULL;

      ALTER TABLE posts
        ADD COLUMN media_id uuid REFERENCES media (id) ON DELETE SET NULL;
      CREATE INDEX posts_media_id ON posts (media_id) WHERE media_id IS NOT NULL;
    `,
  },
  {
    // Slice 10 — scheduling, grace window, and drafts. A Scheduled Post's
    // Targets are created up front (they carry the platform selection) but are
    // never attempted until the scheduler's minute tick finds them due; a Draft
    // has no obligation to be complete or gated at all.
    name: "009_scheduling",
    sql: /* sql */ `
      ALTER TABLE posts
        -- Always UTC; the Client's timezone (clients.timezone) is applied only
        -- when rendering, never stored per-Post (CONTEXT.md \`Client\`).
        ADD COLUMN scheduled_at timestamptz,
        -- Symmetric: a Post has a schedule if and only if it is \`scheduled\` —
        -- \`updatePostStatus\` clears it the moment a Post fires or is missed,
        -- so this holds in both directions, not just "scheduled implies a time".
        ADD CONSTRAINT posts_scheduled_requires_time
          CHECK ((status = 'scheduled') = (scheduled_at IS NOT NULL));

      -- The scheduler's due-query, mirroring targets_next_retry_at and
      -- media_purge_at: a partial index over exactly what "due" ever means.
      CREATE INDEX posts_due_scheduled
        ON posts (scheduled_at)
        WHERE status = 'scheduled' AND scheduled_at IS NOT NULL;
    `,
  },
];
