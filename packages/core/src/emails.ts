/**
 * What counts as an email address, and what one looks like once stored.
 *
 * Shared because both identities on the platform are keyed by email — a Client's
 * User and a Superadmin — and they must agree on it exactly. If the two services
 * normalized differently, an address could be created in one form and be
 * unfindable in the other; if they validated differently, an account could exist
 * that its own login route rejects.
 */

// Deliberately liberal: enough to reject obvious non-emails, not to relitigate
// RFC 5322. Real deliverability is proven by the password-reset email later.
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** The stored form of an address: trimmed and lowercased. */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Whether a (normalized) address is usable as a login identity. */
export function isValidEmail(email: string): boolean {
  return EMAIL_PATTERN.test(email);
}
