import { randomInt } from "node:crypto";
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

/**
 * The alphabet a generated password is drawn from: the printable ASCII letters
 * and digits, minus the glyphs that read as each other — `l`/`I`/`1`, `O`/`0`.
 *
 * These passwords are conveyed out of band and sometimes re-typed by hand, so a
 * character that can be transcribed wrong is a support ticket. Dropping eight of
 * them costs a fraction of a bit per character and is bought back by the length
 * below many times over.
 */
const GENERATED_ALPHABET = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** Characters per hyphen-separated group, and how many groups. */
const GENERATED_GROUP_SIZE = 5;
const GENERATED_GROUPS = 4;

/**
 * Generate a password nobody chose — the Superadmin panel's answer to a Client
 * being provisioned with a weak or reused one (PRD #15). The panel has nowhere
 * to type one, so no Client is handed a credential an operator invented.
 *
 * Twenty characters over a 56-character alphabet is ~116 bits, far past
 * anything the {@link isStrongPassword} minimum governs — that rule goes on
 * governing the paths where a human does choose their own (the Superadmin CLI
 * and a User's self-service reset), and a generated password satisfies it by
 * construction. Hyphenated into groups purely so it can be read aloud or
 * re-typed without losing your place.
 *
 * `randomInt` rather than `Math.random`: this is a credential, and it is drawn
 * without the modulo bias a naive `% alphabet.length` would introduce.
 */
export function generatePassword(): string {
  const groups: string[] = [];
  for (let group = 0; group < GENERATED_GROUPS; group++) {
    let chars = "";
    for (let i = 0; i < GENERATED_GROUP_SIZE; i++) {
      chars += GENERATED_ALPHABET[randomInt(GENERATED_ALPHABET.length)];
    }
    groups.push(chars);
  }
  return groups.join("-");
}

/**
 * A real bcrypt hash (cost 12) of a value nobody will match.
 *
 * Every login path compares against this when the email is unknown, so that a
 * missing account and a wrong password take indistinguishable time and neither
 * form can be used to discover who exists. Shared so the two of them cannot
 * quietly diverge in cost — a cheaper hash on one surface is a timing signal.
 */
export const DUMMY_PASSWORD_HASH =
  "$2a$12$PPAvF.2H4T9DXVsrN/M12uskhulyNd1bmA4CnuaLbT51DC1myBQ06";

export async function hashPassword(plaintext: string): Promise<string> {
  return bcrypt.hash(plaintext, BCRYPT_COST);
}

export async function verifyPassword(plaintext: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plaintext, hash);
}
