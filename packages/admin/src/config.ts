/**
 * The Superadmin service's configuration — deliberately almost nothing.
 *
 * `DATABASE_URL` is the only thing it *requires* (ADR 0010), so deploying the
 * panel somewhere new is not an exercise in reconstructing configuration. There
 * is no shared Superadmin token to leave behind, no Redis, and above all no
 * token-encryption key: this service never touches a Client's platform tokens
 * and must not be handed the key that would let it.
 */
export interface AdminConfig {
  databaseUrl: string;
  apiPort: number;
  /**
   * Whether the session cookie carries `Secure`. On by default, because it
   * guards a credential that can suspend every Client. Turn it off only to work
   * on a local stack served over plain HTTP, which is why the name says so.
   */
  cookieSecure: boolean;
}

export function loadAdminConfig(): AdminConfig {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("Missing required environment variable: DATABASE_URL");
  }

  return {
    databaseUrl,
    apiPort: Number(process.env.ADMIN_API_PORT ?? 3002),
    cookieSecure: process.env.ADMIN_INSECURE_COOKIE !== "true",
  };
}
