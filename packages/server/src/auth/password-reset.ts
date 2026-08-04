import { createHash, randomBytes } from "node:crypto";
import type pg from "pg";
import type { Clock } from "../core/clock.js";
import type { EmailSender } from "../core/email.js";
import { hashPassword, isStrongPassword, WEAK_PASSWORD_MESSAGE } from "@smma/core";

/**
 * Self-service password reset (Slice 4). A User who forgets their password
 * requests an expiring link by email; opening it and choosing a new password
 * completes the reset and lets them log in again.
 *
 * The raw token lives only in the emailed link — we store its SHA-256 hash, so
 * a database dump cannot be used to seize accounts. A token is single-use and
 * time-bounded: {@link completePasswordReset} atomically consumes it, and both
 * expiry and prior consumption are checked against the injected {@link Clock},
 * never `Date.now()`, so tests can drive the lifecycle deterministically.
 */

/** How long a reset link stays valid after it is issued. */
const RESET_TTL_MS = 60 * 60 * 1000; // 1 hour

export class PasswordResetError extends Error {
  constructor(readonly code: "invalid_token" | "weak_password") {
    super(code === "weak_password" ? WEAK_PASSWORD_MESSAGE : "Invalid or expired reset link.");
    this.name = "PasswordResetError";
  }
}

/** SHA-256 of the raw token — what we store and look up by. */
function hashToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

/**
 * Build the reset link a User clicks. It points back at the User's own Client
 * subdomain (where the SPA's reset page lives). `localhost` dev uses http; every
 * real base domain uses https.
 */
export function resetLink(subdomain: string, baseDomain: string, rawToken: string): string {
  const scheme = baseDomain === "localhost" || baseDomain.endsWith(".localhost") ? "http" : "https";
  return `${scheme}://${subdomain}.${baseDomain}/reset-password?token=${encodeURIComponent(rawToken)}`;
}

/**
 * Issue a reset link for the User with `email` under a Client and email it.
 *
 * To avoid leaking which emails exist, this always resolves quietly: if no User
 * matches, no token is created and no mail is sent, and the caller still returns
 * the same generic response. Issuing a new link first drops the Client's User's
 * other pending links, so only the most recent one is ever valid.
 */
export async function requestPasswordReset(
  pool: pg.Pool,
  clock: Clock,
  emailSender: EmailSender,
  input: { clientId: string; subdomain: string; email: string; baseDomain: string },
): Promise<void> {
  const email = input.email.trim().toLowerCase();
  const { rows } = await pool.query<{ id: string; email: string }>(
    `SELECT id, email FROM users WHERE lower(email) = $1 AND client_id = $2`,
    [email, input.clientId],
  );
  const user = rows[0];
  if (!user) return; // Unknown email — respond identically, send nothing.

  const rawToken = randomBytes(32).toString("base64url");
  const expiresAt = new Date(clock.now().getTime() + RESET_TTL_MS);

  // One active link per User: supersede any earlier unconsumed tokens.
  await pool.query(
    `DELETE FROM password_reset_tokens WHERE user_id = $1 AND consumed_at IS NULL`,
    [user.id],
  );
  await pool.query(
    `INSERT INTO password_reset_tokens (token_hash, user_id, expires_at) VALUES ($1, $2, $3)`,
    [hashToken(rawToken), user.id, expiresAt.toISOString()],
  );

  const link = resetLink(input.subdomain, input.baseDomain, rawToken);
  try {
    await emailSender.send({
      to: user.email,
      subject: "Reset your password",
      text:
        `We received a request to reset your password.\n\n` +
        `Open this link to choose a new one (it expires in 1 hour):\n${link}\n\n` +
        `If you didn't request this, you can ignore this email.`,
    });
  } catch (err) {
    // Swallow a provider failure: surfacing it would 500 only for a real User
    // (an unknown email returns early and never sends), turning the send into a
    // user-enumeration oracle. Log it so a misconfiguration is still visible.
    console.error(`Failed to send password-reset email to ${user.email}:`, err);
  }
}

/**
 * Complete a reset: consume the token and set the new password. The token is
 * bound to the Client resolved from the subdomain, single-use, and unexpired;
 * any failing check surfaces the same generic `invalid_token`. On success the
 * User's live sessions are revoked so only the new password works anywhere.
 *
 * @throws {PasswordResetError} `weak_password` if the new password is too short,
 * `invalid_token` if the token is unknown, foreign, expired, or already used.
 */
export async function completePasswordReset(
  pool: pg.Pool,
  clock: Clock,
  input: { clientId: string; token: string; newPassword: string },
): Promise<void> {
  if (!isStrongPassword(input.newPassword)) {
    throw new PasswordResetError("weak_password");
  }
  const now = clock.now();

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Atomically consume: the token must be unconsumed, unexpired, and belong to
    // a User of this Client. Doing it in one UPDATE closes any double-use race.
    const { rows } = await client.query<{ user_id: string }>(
      `UPDATE password_reset_tokens t
         SET consumed_at = $2
        FROM users u
       WHERE t.token_hash = $1
         AND t.user_id = u.id
         AND u.client_id = $3
         AND t.consumed_at IS NULL
         AND t.expires_at > $2
       RETURNING t.user_id`,
      [hashToken(input.token), now.toISOString(), input.clientId],
    );
    const row = rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      throw new PasswordResetError("invalid_token");
    }

    // Hash only once the token is known-valid. This endpoint is unauthenticated,
    // so hashing before the cheap token check would let anyone force a cost-12
    // bcrypt per request with a garbage token (CPU-amplification DoS).
    const passwordHash = await hashPassword(input.newPassword);
    await client.query(`UPDATE users SET password_hash = $2 WHERE id = $1`, [
      row.user_id,
      passwordHash,
    ]);
    // Revoke live sessions and any sibling reset links for the User.
    await client.query(`DELETE FROM sessions WHERE user_id = $1`, [row.user_id]);
    await client.query(
      `DELETE FROM password_reset_tokens WHERE user_id = $1 AND consumed_at IS NULL`,
      [row.user_id],
    );

    await client.query("COMMIT");
  } catch (err) {
    if (!(err instanceof PasswordResetError)) {
      await client.query("ROLLBACK").catch(() => {});
    }
    throw err;
  } finally {
    client.release();
  }
}
