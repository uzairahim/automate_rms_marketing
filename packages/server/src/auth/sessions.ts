import { randomBytes } from "node:crypto";
import type pg from "pg";
import type { Clock } from "../core/clock.js";
import { verifyPassword } from "./passwords.js";

/**
 * User login and session resolution — the read side of the tenancy spine.
 *
 * Login is always scoped to a resolved Client: a User authenticates only
 * against the Client they belong to, so the same credentials presented on a
 * different Client's subdomain fail exactly as bad credentials do. To avoid
 * leaking which emails exist, every failure returns the same generic error.
 */

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export class AuthError extends Error {
  constructor(readonly code: "invalid_credentials" = "invalid_credentials") {
    super("Invalid email or password.");
    this.name = "AuthError";
  }
}

export interface SessionUser {
  id: string;
  clientId: string;
  email: string;
}

/**
 * Authenticate a User against a specific Client and open a session.
 *
 * @throws {AuthError} if no User with that email belongs to the Client, or the
 * password does not match — the two are indistinguishable to the caller.
 */
export async function login(
  pool: pg.Pool,
  clock: Clock,
  input: { clientId: string; email: string; password: string },
): Promise<{ token: string; user: SessionUser }> {
  const email = input.email.trim().toLowerCase();
  const { rows } = await pool.query<{
    id: string;
    client_id: string;
    email: string;
    password_hash: string;
  }>(
    `SELECT id, client_id, email, password_hash
     FROM users
     WHERE lower(email) = $1 AND client_id = $2`,
    [email, input.clientId],
  );

  const row = rows[0];
  if (!row) {
    // Still spend the cost of a hash comparison so a missing user and a wrong
    // password take indistinguishable time (mitigates user-enumeration timing).
    await verifyPassword(input.password, DUMMY_HASH);
    throw new AuthError();
  }
  if (!(await verifyPassword(input.password, row.password_hash))) {
    throw new AuthError();
  }

  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(clock.now().getTime() + SESSION_TTL_MS);
  await pool.query(
    `INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, $3)`,
    [token, row.id, expiresAt.toISOString()],
  );

  return {
    token,
    user: { id: row.id, clientId: row.client_id, email: row.email },
  };
}

/**
 * Resolve a bearer session token to its User, or null if the token is unknown
 * or expired. Expiry is checked against the injected {@link Clock}.
 */
export async function resolveSession(
  pool: pg.Pool,
  clock: Clock,
  token: string,
): Promise<SessionUser | null> {
  const { rows } = await pool.query<{
    id: string;
    client_id: string;
    email: string;
    expires_at: Date;
  }>(
    `SELECT u.id, u.client_id, u.email, s.expires_at
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token = $1`,
    [token],
  );

  const row = rows[0];
  if (!row) return null;
  if (row.expires_at.getTime() <= clock.now().getTime()) return null;

  return { id: row.id, clientId: row.client_id, email: row.email };
}

// A real bcrypt hash (cost 12) of a value no user will match, used only to keep
// login timing uniform when the email is unknown, so the comparison does real work.
const DUMMY_HASH = "$2a$12$PPAvF.2H4T9DXVsrN/M12uskhulyNd1bmA4CnuaLbT51DC1myBQ06";
