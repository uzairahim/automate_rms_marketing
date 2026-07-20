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
  /**
   * Transactional email (Slice 4). `from` is the sender address on every
   * outbound message. `resendApiKey` is the provider key read from the
   * environment — when set, real mail is sent via Resend; when absent (local
   * dev), the app falls back to a console sender that logs the reset link.
   */
  email: {
    from: string;
    resendApiKey?: string;
  };
  /**
   * Base64 32-byte key for encrypting platform tokens at rest (ADR 0006).
   * Required: there is no "unencrypted" mode, because a database dump alone must
   * be useless. **Losing this key forces every Client to reconnect every social
   * account** — back it up somewhere other than the database.
   */
  tokenEncryptionKey: string;
  /**
   * Origin of the canonical OAuth callback surface. Every Client's handshake
   * comes back through this one host: Meta will not whitelist a wildcard
   * redirect URI, so it cannot be per-subdomain.
   */
  oauthRedirectBaseUrl: string;
  /**
   * Our Meta app (Slice 6). Absent in local dev, in which case the app falls
   * back to the fake Publisher — the same shape as the email sender's fallback,
   * so a fresh checkout runs with no Meta credentials at all.
   */
  meta: {
    appId?: string;
    appSecret?: string;
  };
  /**
   * Our TikTok app (Slice 7). Absent in local dev, in which case TikTok falls
   * back to the fake Publisher independently of Meta — the two platforms are two
   * reviews on two timelines, so either may be live while the other is not.
   */
  tiktok: {
    clientKey?: string;
    clientSecret?: string;
  };
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function loadConfig(): Config {
  const apiPort = Number(process.env.API_PORT ?? 3001);

  return {
    databaseUrl: required("DATABASE_URL"),
    redisUrl: required("REDIS_URL"),
    apiPort,
    baseDomain: process.env.BASE_DOMAIN ?? "localhost",
    superadminToken: required("SUPERADMIN_TOKEN"),
    email: {
      from: process.env.EMAIL_FROM ?? "no-reply@localhost",
      resendApiKey: process.env.RESEND_API_KEY,
    },
    tokenEncryptionKey: required("TOKEN_ENCRYPTION_KEY"),
    // Defaults to the Vite dev server, not the API: the callback URL is a *page*
    // the User is returned to, and the SPA is what renders it.
    oauthRedirectBaseUrl: process.env.OAUTH_REDIRECT_BASE_URL ?? "http://localhost:5173",
    meta: {
      appId: process.env.META_APP_ID,
      appSecret: process.env.META_APP_SECRET,
    },
    tiktok: {
      clientKey: process.env.TIKTOK_CLIENT_KEY,
      clientSecret: process.env.TIKTOK_CLIENT_SECRET,
    },
  };
}
