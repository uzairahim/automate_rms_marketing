/**
 * Runtime configuration read from the environment.
 *
 * Kept intentionally small for the walking skeleton. Later slices extend this
 * (token-encryption key, SMTP/transactional-email config, base domain for
 * subdomain routing, etc.).
 */
export interface Config {
  databaseUrl: string;
  redisUrl: string;
  apiPort: number;
  /**
   * The base domain the app is served under (e.g. `ourapp.com`). Client
   * subdomains and the reserved `admin.` surface are resolved by stripping this
   * suffix off the request Host header. In local dev it is `localhost`.
   */
  baseDomain: string;
  /**
   * Shared secret that gates the Superadmin `admin.` API surface. Sent as a
   * bearer token on admin requests. Slice 2 uses a single provisioned secret;
   * a full Superadmin login can layer on later without changing the routes.
   */
  superadminToken: string;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function loadConfig(): Config {
  return {
    databaseUrl: required("DATABASE_URL"),
    redisUrl: required("REDIS_URL"),
    apiPort: Number(process.env.API_PORT ?? 3001),
    baseDomain: process.env.BASE_DOMAIN ?? "localhost",
    superadminToken: required("SUPERADMIN_TOKEN"),
  };
}
