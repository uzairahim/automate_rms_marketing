import type pg from "pg";
import { hashPassword, isStrongPassword, WEAK_PASSWORD_MESSAGE } from "./passwords.js";
import { isValidEmail, normalizeEmail } from "./emails.js";
import { isValidSubdomain } from "./subdomain.js";
import { ProvisionError } from "./errors.js";
import { planFromRow, type Plan, type PlanColumns, type PlanPatch } from "./plan.js";

/**
 * The Client/User provisioning store — the write side of the tenancy spine.
 *
 * These functions are the only place that inserts Clients and Users, so the
 * platform-wide invariants live here: a valid, unique subdomain per Client; a
 * valid timezone; and a globally unique email per User (the same email can
 * never belong to two Clients). Uniqueness is enforced by DB constraints and
 * surfaced as {@link ProvisionError} so callers never race a check-then-insert.
 */

export { ProvisionError, type ProvisionErrorCode } from "./errors.js";

export interface Client {
  id: string;
  subdomain: string;
  timezone: string;
  createdAt: string;
  /** The Superadmin-configured gating bundle (platform toggles + access status). */
  plan: Plan;
}

export interface User {
  id: string;
  clientId: string;
  email: string;
}

/** A User as the Superadmin sees one — with when they were provisioned. */
export interface ListedUser extends User {
  createdAt: string;
}

/** The `clients` columns every read path selects, including the Plan columns. */
interface ClientRow extends PlanColumns {
  id: string;
  subdomain: string;
  timezone: string;
  created_at: Date;
}

/** The column list every Client read selects — kept in one place. */
const CLIENT_COLUMNS = `id, subdomain, timezone, created_at,
  facebook_enabled, instagram_enabled, tiktok_enabled, access_status`;

function clientFromRow(row: ClientRow): Client {
  return {
    id: row.id,
    subdomain: row.subdomain,
    timezone: row.timezone,
    createdAt: row.created_at.toISOString(),
    plan: planFromRow(row),
  };
}

/** Whether the runtime's ICU data recognizes this IANA timezone name. */
function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

const PG_UNIQUE_VIOLATION = "23505";

function isUniqueViolation(err: unknown, constraint: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === PG_UNIQUE_VIOLATION &&
    (err as { constraint?: string }).constraint === constraint
  );
}

/**
 * Provision a new Client. Rejects an invalid/taken subdomain or bad timezone.
 * The Plan's platform toggles may be set at creation via `plan`; any omitted
 * toggle defaults off (a Client sees and pays for only what it needs). A new
 * Client is always `active` — the Superadmin suspends/expires it later.
 */
export async function createClient(
  pool: pg.Pool,
  input: { subdomain: string; timezone: string; plan?: PlanPatch },
): Promise<Client> {
  const subdomain = input.subdomain.trim().toLowerCase();
  const timezone = input.timezone.trim();

  if (!isValidSubdomain(subdomain)) {
    throw new ProvisionError(
      "invalid_subdomain",
      "Subdomain must be a single DNS label (a–z, 0–9, hyphens) and not 'admin'.",
    );
  }
  if (!isValidTimezone(timezone)) {
    throw new ProvisionError("invalid_timezone", `Unknown timezone: ${timezone}`);
  }

  const facebook = input.plan?.facebook ?? false;
  const instagram = input.plan?.instagram ?? false;
  const tiktok = input.plan?.tiktok ?? false;

  try {
    const { rows } = await pool.query<ClientRow>(
      `INSERT INTO clients (subdomain, timezone, facebook_enabled, instagram_enabled, tiktok_enabled)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${CLIENT_COLUMNS}`,
      [subdomain, timezone, facebook, instagram, tiktok],
    );
    return clientFromRow(rows[0]!);
  } catch (err) {
    if (isUniqueViolation(err, "clients_subdomain_key")) {
      throw new ProvisionError("subdomain_taken", `Subdomain already in use: ${subdomain}`);
    }
    throw err;
  }
}

/** All Clients, newest first — the Superadmin's single global view. */
export async function listClients(pool: pg.Pool): Promise<Client[]> {
  const { rows } = await pool.query<ClientRow>(
    `SELECT ${CLIENT_COLUMNS}
     FROM clients
     ORDER BY created_at DESC, subdomain ASC`,
  );
  return rows.map(clientFromRow);
}

/**
 * Provision a User under an existing Client. The email is normalized and must
 * be globally unique; a collision anywhere on the platform is rejected. The
 * password is hashed before it is ever stored.
 */
export async function createUser(
  pool: pg.Pool,
  input: { clientId: string; email: string; password: string },
): Promise<User> {
  const email = normalizeEmail(input.email);

  if (!isValidEmail(email)) {
    throw new ProvisionError("invalid_email", `Not a valid email address: ${input.email}`);
  }
  if (!isStrongPassword(input.password)) {
    throw new ProvisionError("weak_password", WEAK_PASSWORD_MESSAGE);
  }

  const passwordHash = await hashPassword(input.password);

  try {
    const { rows } = await pool.query<{ id: string; client_id: string; email: string }>(
      `INSERT INTO users (client_id, email, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id, client_id, email`,
      [input.clientId, email, passwordHash],
    );
    const row = rows[0]!;
    return { id: row.id, clientId: row.client_id, email: row.email };
  } catch (err) {
    if (isUniqueViolation(err, "users_email_unique")) {
      throw new ProvisionError("email_taken", `Email already in use: ${email}`);
    }
    // A missing FK (23503) or a malformed uuid (22P02) both mean the caller
    // named a Client that cannot exist — surfaced as 404.
    const code = (err as { code?: string })?.code;
    if (code === "23503" || code === "22P02") {
      throw new ProvisionError("client_not_found", `No such Client: ${input.clientId}`);
    }
    throw err;
  }
}

/**
 * Every User of one Client, oldest first.
 *
 * The one administrative *read* the panel needs that nothing else on the
 * platform performs: no Client-facing route ever returns a User's identifier —
 * a User only ever learns about themselves — which is what made the
 * password-reset path unreachable from any UI (PRD #15).
 *
 * Oldest first because the order Users were added is the order they mean
 * something in: the Client's first login stays at the top of the list rather
 * than sinking as their colleagues are added.
 *
 * Deliberately never selects `password_hash`. A read that carries a credential
 * digest is one careless `SELECT *` away from being logged, and nothing that
 * lists Users has any use for it.
 */
export async function listUsers(pool: pg.Pool, clientId: string): Promise<ListedUser[]> {
  const { rows } = await pool.query<{
    id: string;
    client_id: string;
    email: string;
    created_at: Date;
  }>(
    `SELECT id, client_id, email, created_at
     FROM users
     WHERE client_id = $1
     ORDER BY created_at ASC, email ASC`,
    [clientId],
  );
  return rows.map((row) => ({
    id: row.id,
    clientId: row.client_id,
    email: row.email,
    createdAt: row.created_at.toISOString(),
  }));
}

/**
 * One User, looked up **within** a Client, or null.
 *
 * Scoped rather than by bare id on purpose: the only caller is the Superadmin
 * acting from one Client's screen, and a User outside that Client is not
 * something that screen may touch however its id was arrived at. Passing the
 * tenant in is what makes "not found" and "not yours" the same answer, which is
 * the answer both should have.
 *
 * A malformed uuid is null rather than an error, matching {@link findClientById}.
 */
export async function findUser(
  pool: pg.Pool,
  input: { clientId: string; userId: string },
): Promise<User | null> {
  let rows: Array<{ id: string; client_id: string; email: string }>;
  try {
    ({ rows } = await pool.query(
      `SELECT id, client_id, email FROM users WHERE id = $1 AND client_id = $2`,
      [input.userId, input.clientId],
    ));
  } catch (err) {
    if ((err as { code?: string })?.code === "22P02") return null;
    throw err;
  }
  const row = rows[0];
  return row ? { id: row.id, clientId: row.client_id, email: row.email } : null;
}

/**
 * Set a User's password directly — the Superadmin's out-of-band unblock for a
 * User who cannot use the self-service reset flow (Slice 4). The password is
 * hashed before storage and every one of the User's live sessions is revoked,
 * so a set password immediately takes effect everywhere. Any outstanding
 * self-service reset tokens for the User are also dropped.
 *
 * @throws {ProvisionError} `weak_password` if the new password is too short,
 * `user_not_found` if no User has that id (including a malformed uuid).
 */
export async function setUserPassword(
  pool: pg.Pool,
  input: { userId: string; password: string },
): Promise<void> {
  if (!isStrongPassword(input.password)) {
    throw new ProvisionError("weak_password", WEAK_PASSWORD_MESSAGE);
  }
  const passwordHash = await hashPassword(input.password);

  // Set the password and revoke live sessions + pending reset links as one unit,
  // so "immediately takes effect everywhere" can't be left half-applied by a
  // mid-sequence failure (matching completePasswordReset's atomicity).
  const conn = await pool.connect();
  try {
    await conn.query("BEGIN");

    let rowCount: number | null;
    try {
      ({ rowCount } = await conn.query(`UPDATE users SET password_hash = $2 WHERE id = $1`, [
        input.userId,
        passwordHash,
      ]));
    } catch (err) {
      // A malformed uuid (22P02) names a User that cannot exist → 404.
      if ((err as { code?: string })?.code === "22P02") {
        throw new ProvisionError("user_not_found", `No such User: ${input.userId}`);
      }
      throw err;
    }
    if (!rowCount) {
      throw new ProvisionError("user_not_found", `No such User: ${input.userId}`);
    }

    await conn.query(`DELETE FROM sessions WHERE user_id = $1`, [input.userId]);
    await conn.query(`DELETE FROM password_reset_tokens WHERE user_id = $1`, [input.userId]);

    await conn.query("COMMIT");
  } catch (err) {
    await conn.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Look up a Client by id, or null.
 *
 * The by-id counterpart to {@link findClientBySubdomain}, for the paths that
 * cannot resolve a tenant from the host: an OAuth callback returning through the
 * shared redirect URI, a platform webhook that has no host of ours at all, and
 * the Superadmin naming a Client explicitly rather than by subdomain.
 *
 * A malformed uuid is null rather than an error, matching how the write paths
 * treat one: an id that cannot name a Client names no Client, and every caller
 * would otherwise have to catch a Postgres code to say so.
 */
export async function findClientById(pool: pg.Pool, clientId: string): Promise<Client | null> {
  let rows: ClientRow[];
  try {
    ({ rows } = await pool.query<ClientRow>(
      `SELECT ${CLIENT_COLUMNS} FROM clients WHERE id = $1`,
      [clientId],
    ));
  } catch (err) {
    if ((err as { code?: string })?.code === "22P02") return null;
    throw err;
  }
  const row = rows[0];
  return row ? clientFromRow(row) : null;
}

/** Look up a Client by its subdomain, or null. Used to resolve the tenant scope. */
export async function findClientBySubdomain(
  pool: pg.Pool,
  subdomain: string,
): Promise<Client | null> {
  const { rows } = await pool.query<ClientRow>(
    `SELECT ${CLIENT_COLUMNS} FROM clients WHERE subdomain = $1`,
    [subdomain.toLowerCase()],
  );
  const row = rows[0];
  return row ? clientFromRow(row) : null;
}
