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

export async function hashPassword(plaintext: string): Promise<string> {
  return bcrypt.hash(plaintext, BCRYPT_COST);
}

export async function verifyPassword(plaintext: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plaintext, hash);
}
