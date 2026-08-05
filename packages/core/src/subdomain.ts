/**
 * Subdomain routing — how a request's Host header becomes a surface.
 *
 * Every Client is reached at its own subdomain, and the Client is derived from
 * that subdomain (ADR 0001, PRD "Surfaces"). The `admin.` label is reserved so
 * no Client can claim it, but nothing is served there: the Superadmin's
 * application is its own deployable on its own host, with no Host-header
 * tenancy at all (ADR 0010). So `admin.` resolves to a surface of its own here
 * only to keep it from ever being read as a Client.
 */

/** The reserved label, held back from Clients; never routed to anything. */
export const ADMIN_SUBDOMAIN = "admin";

export type Surface =
  | { kind: "admin" }
  | { kind: "client"; subdomain: string }
  | { kind: "unknown" };

/**
 * Classify a request Host header against the configured base domain.
 *
 * `admin.ourapp.com` → admin surface; `acme.ourapp.com` → the `acme` Client;
 * anything that is not a single label under the base domain (the apex itself, a
 * foreign host, a multi-label subdomain) → `unknown`. The port, if any, is
 * ignored. Matching is case-insensitive.
 */
export function resolveSurface(host: string | undefined, baseDomain: string): Surface {
  if (!host) return { kind: "unknown" };

  const hostname = host.split(":")[0]?.toLowerCase().replace(/\.$/, "") ?? "";
  const base = baseDomain.toLowerCase().replace(/\.$/, "");
  if (!hostname || !base) return { kind: "unknown" };

  if (hostname === base) return { kind: "unknown" }; // apex has no tenant
  if (!hostname.endsWith(`.${base}`)) return { kind: "unknown" };

  const label = hostname.slice(0, -(base.length + 1));
  // Only a single-label subdomain is a valid surface (no `a.b.ourapp.com`).
  if (label.length === 0 || label.includes(".")) return { kind: "unknown" };

  if (label === ADMIN_SUBDOMAIN) return { kind: "admin" };
  return { kind: "client", subdomain: label };
}

const SUBDOMAIN_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Whether a string is usable as a Client subdomain: a single DNS label —
 * lowercase alphanumeric and hyphens, not starting/ending with a hyphen, 1–63
 * chars — and not the reserved `admin` label. Used at provisioning time.
 */
export function isValidSubdomain(subdomain: string): boolean {
  if (subdomain === ADMIN_SUBDOMAIN) return false;
  return SUBDOMAIN_PATTERN.test(subdomain);
}
