import type pg from "pg";
import { hashPassword } from "../auth/passwords.js";
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

// Deliberately liberal: enough to reject obvious non-emails, not to relitigate
// RFC 5322. Real deliverability is proven by the password-reset email later.
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

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
  const email = input.email.trim().toLowerCase();

  if (!EMAIL_PATTERN.test(email)) {
    throw new ProvisionError("invalid_email", `Not a valid email address: ${input.email}`);
  }
  if (input.password.length < 8) {
    throw new ProvisionError("weak_password", "Password must be at least 8 characters.");
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
