import { randomBytes } from "node:crypto";
import type pg from "pg";
import {
  DUMMY_PASSWORD_HASH,
  hashPassword,
  isStrongPassword,
  isValidEmail,
  normalizeEmail,
  ProvisionError,
  verifyPassword,
  WEAK_PASSWORD_MESSAGE,
} from "@smma/core";
import type { Clock } from "../clock.js";

/**
 * The Superadmin identity: who the operator is, and how they hold a session.
 *
 * A Superadmin is a named person with an email and a bcrypt hash — not a shared
 * secret with no owner, and not a User with a null Client (ADR 0010). The two
 * identities never meet: this module only ever reads `superadmins`, so a Client
 * User's credentials cannot authenticate here no matter what is presented, and
 * a Superadmin has no row the Client-facing login could ever find.
 *
 * Every failure is the same failure, so the login form cannot be used to
 * discover which operator accounts exist.
 *
 * On naming: the *person* is a Superadmin, never an "admin" (CONTEXT.md
 * `Superadmin`, _Avoid_: Admin). `admin` names only the service, its surface,
 * and its `admin_sessions` table — the session record this Superadmin holds.
 */

/**
 * How long an operator session lives — deliberately far shorter than the
 * Client's 30 days. This credential can suspend every Client on the platform, so
 * an unattended browser should stop being one long before a User's would.
 */
export const ADMIN_SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours

export class SuperadminAuthError extends Error {
  constructor(readonly code: "invalid_credentials" = "invalid_credentials") {
    super("Invalid email or password.");
    this.name = "SuperadminAuthError";
  }
}

export interface Superadmin {
  id: string;
  email: string;
}

/**
 * Create the Superadmin with this email, or reset their password if they already
 * exist — the CLI's whole behavior, and therefore also the lockout-recovery
 * path. Resetting ends that operator's live sessions, so recovering a lost
 * password never leaves whoever had the old one signed in.
 *
 * @throws {ProvisionError} `invalid_email` or `weak_password`.
 */
export async function upsertSuperadmin(
  pool: pg.Pool,
  input: { email: string; password: string },
): Promise<{ id: string; email: string; created: boolean }> {
  const email = normalizeEmail(input.email);

  if (!isValidEmail(email)) {
    throw new ProvisionError("invalid_email", `Not a valid email address: ${input.email}`);
  }
  if (!isStrongPassword(input.password)) {
    throw new ProvisionError("weak_password", WEAK_PASSWORD_MESSAGE);
  }

  const passwordHash = await hashPassword(input.password);

  const conn = await pool.connect();
  try {
    await conn.query("BEGIN");
    // Keyed on the same expression as the unique index, so a re-run for
    // `Operator@…` updates the account created as `operator@…` rather than
    // colliding with it.
    const { rows } = await conn.query<{ id: string; email: string; created: boolean }>(
      `INSERT INTO superadmins (email, password_hash)
       VALUES ($1, $2)
       ON CONFLICT (lower(email)) DO UPDATE SET password_hash = EXCLUDED.password_hash
       RETURNING id, email, (xmax = 0) AS created`,
      [email, passwordHash],
    );
    const row = rows[0]!;
    if (!row.created) {
      await conn.query(`DELETE FROM admin_sessions WHERE superadmin_id = $1`, [row.id]);
    }
    await conn.query("COMMIT");
    return { id: row.id, email: row.email, created: row.created };
  } catch (err) {
    await conn.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Authenticate a Superadmin and open a session.
 *
 * @throws {SuperadminAuthError} if no Superadmin has that email, or the password does
 * not match — the two are indistinguishable to the caller.
 */
export async function authenticateSuperadmin(
  pool: pg.Pool,
  clock: Clock,
  input: { email: string; password: string },
): Promise<{ token: string; superadmin: Superadmin }> {
  const email = normalizeEmail(input.email);
  const { rows } = await pool.query<{ id: string; email: string; password_hash: string }>(
    `SELECT id, email, password_hash FROM superadmins WHERE lower(email) = $1`,
    [email],
  );

  const row = rows[0];
  if (!row) {
    // Still spend the cost of a hash comparison so an unknown email and a wrong
    // password take indistinguishable time (mitigates account-enumeration timing).
    await verifyPassword(input.password, DUMMY_PASSWORD_HASH);
    throw new SuperadminAuthError();
  }
  if (!(await verifyPassword(input.password, row.password_hash))) {
    throw new SuperadminAuthError();
  }

  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(clock.now().getTime() + ADMIN_SESSION_TTL_MS);
  await pool.query(
    `INSERT INTO admin_sessions (token, superadmin_id, expires_at) VALUES ($1, $2, $3)`,
    [token, row.id, expiresAt.toISOString()],
  );

  return { token, superadmin: { id: row.id, email: row.email } };
}

/**
 * Resolve a session token to its Superadmin, or null if the token is unknown or
 * expired. Expiry is checked against the injected {@link Clock}.
 */
export async function resolveAdminSession(
  pool: pg.Pool,
  clock: Clock,
  token: string,
): Promise<Superadmin | null> {
  const { rows } = await pool.query<{ id: string; email: string; expires_at: Date }>(
    `SELECT s.superadmin_id AS id, a.email, s.expires_at
     FROM admin_sessions s
     JOIN superadmins a ON a.id = s.superadmin_id
     WHERE s.token = $1`,
    [token],
  );

  const row = rows[0];
  if (!row) return null;
  if (row.expires_at.getTime() <= clock.now().getTime()) return null;

  return { id: row.id, email: row.email };
}

/** End a session. Silent if the token is already gone — logout is not a query. */
export async function endAdminSession(pool: pg.Pool, token: string): Promise<void> {
  await pool.query(`DELETE FROM admin_sessions WHERE token = $1`, [token]);
}
