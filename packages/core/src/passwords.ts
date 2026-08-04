import bcrypt from "bcryptjs";

/**
 * Password hashing (ADR 0006) — User passwords are hashed, never reversibly
 * encrypted. We use bcrypt (one of the two the ADR names) via the pure-JS
 * `bcryptjs` so there is no native build step on the small VPS.
 *
 * The cost factor is a deliberate balance: high enough to be slow to brute
 * force, low enough not to stall the single API process on each login.
 */
const BCRYPT_COST = 12;

/**
 * The one place the password-strength rule lives, so every path that sets a
 * password — provisioning, self-service reset, and the Superadmin's direct set
 * — enforces the same minimum. Deliberately minimal for the MVP (length only).
 */
export const MIN_PASSWORD_LENGTH = 8;

/** The single user-facing message for a password that fails the strength rule. */
export const WEAK_PASSWORD_MESSAGE = `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;

/** Whether a plaintext password meets the minimum strength rule. */
export function isStrongPassword(plaintext: string): boolean {
  return plaintext.length >= MIN_PASSWORD_LENGTH;
}

export async function hashPassword(plaintext: string): Promise<string> {
  return bcrypt.hash(plaintext, BCRYPT_COST);
}

export async function verifyPassword(plaintext: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plaintext, hash);
}
