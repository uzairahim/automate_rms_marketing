/**
 * Provisioning errors, shared by the tenancy write paths (Client/User creation,
 * Plan updates, and branding updates). Kept in their own module so
 * {@link ./clients.ts}, {@link ./plan.ts}, and {@link ./branding.ts} can depend
 * on them without importing each other.
 *
 * Each `code` maps to an HTTP status at the route edge, so callers never race a
 * check-then-insert — the DB constraint is the source of truth and the failure
 * is surfaced as one of these.
 */
export type ProvisionErrorCode =
  | "invalid_subdomain"
  | "invalid_timezone"
  | "subdomain_taken"
  | "email_taken"
  | "invalid_email"
  | "weak_password"
  | "invalid_plan"
  | "invalid_access_status"
  | "invalid_app_name"
  | "invalid_primary_color"
  | "invalid_logo_url"
  | "client_not_found"
  | "user_not_found";

export class ProvisionError extends Error {
  constructor(
    readonly code: ProvisionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ProvisionError";
  }
}
