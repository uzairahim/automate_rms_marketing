import type { Platform } from "./api.js";

/**
 * Who is signed in, and what their Client's Plan allows — the shape
 * `/api/auth/login` and `/api/me` both return.
 *
 * The Plan travels with the session because it decides what the app may even
 * offer: a Client with TikTok only is never shown a Facebook connect button. The
 * API enforces the same gate on every request, so this is for what the User
 * *sees*, never the security boundary.
 */
export interface Session {
  token: string;
  user: { id: string; email: string };
  client: {
    id: string;
    subdomain: string;
    timezone: string;
    plan: Record<Platform, boolean> & { accessStatus: string };
  };
}
