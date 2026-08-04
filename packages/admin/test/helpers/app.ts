import type { FastifyInstance, InjectOptions } from "fastify";
import type { Response as InjectResponse } from "light-my-request";
import { buildAdminApp, type AdminAppDeps } from "../../src/app.js";
import { TestClock } from "../../src/clock.js";
import { ADMIN_SESSION_COOKIE } from "../../src/auth/session-cookie.js";

/**
 * Build the real admin app with test seams wired in — a pool on an ephemeral
 * Postgres and a {@link TestClock} — and drive it with Fastify's `inject()` as a
 * real client.
 *
 * It mirrors the Client-facing service's harness deliberately, and just as
 * deliberately has no fake Publisher: the admin service never publishes, and
 * handing it one would imply it might.
 */
export function buildTestAdminApp(
  overrides: Partial<AdminAppDeps> & Pick<AdminAppDeps, "pool">,
): FastifyInstance {
  return buildAdminApp({
    clock: new TestClock(),
    // The real cookie is `Secure`, and `inject()` is not a browser, so the
    // suites assert on the attribute rather than being blocked by it.
    cookieSecure: true,
    ...overrides,
  });
}

/** The shape `inject()` parses a `Set-Cookie` into, attributes and all. */
type InjectedCookie = InjectResponse["cookies"][number];

/** The session cookie the response set, or undefined if it set none. */
export function sessionCookie(res: InjectResponse): InjectedCookie | undefined {
  return res.cookies.find((c) => c.name === ADMIN_SESSION_COOKIE);
}

/** Headers that present a session cookie, as a browser would on the next request. */
export function withSession(token: string): InjectOptions["cookies"] {
  return { [ADMIN_SESSION_COOKIE]: token };
}

/**
 * Log a Superadmin in through the real login route, returning the cookie the
 * browser would then hold. Throws if the credentials do not work, so a suite
 * that meant to be signed in fails where it went wrong rather than later.
 */
export async function loginAs(
  app: FastifyInstance,
  credentials: { email: string; password: string },
): Promise<{ token: string; cookies: InjectOptions["cookies"] }> {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: credentials,
  });
  if (res.statusCode !== 200) {
    throw new Error(`Login failed for ${credentials.email} (${res.statusCode}): ${res.body}`);
  }
  const token = sessionCookie(res)?.value ?? "";
  return { token, cookies: withSession(token) };
}
