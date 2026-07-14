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
  };
}
