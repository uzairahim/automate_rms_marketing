import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import type pg from "pg";
import type { Clock } from "./clock.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerBrandingRoutes } from "./routes/branding.js";
import { registerClientRoutes } from "./routes/clients.js";
import { registerPlanRoutes } from "./routes/plan.js";
import { registerTimezoneRoutes } from "./routes/timezone.js";
import { registerUserRoutes } from "./routes/users.js";

/**
 * The Superadmin API — a separate deployable from the Client-facing service
 * (ADR 0010), so that the code able to suspend every Client is not merely
 * guarded inside the internet-facing process but is not running there at all.
 *
 * Everything it depends on is injected at construction, which is what makes it
 * testable: a pool pointed at an ephemeral Postgres and a `TestClock`, driven
 * with Fastify's `inject()` as a real client. It deliberately has no Publisher,
 * no queue, and no token cipher — the admin service never publishes, never
 * enqueues, and must never be given the key that decrypts a Client's platform
 * tokens.
 */
export interface AdminAppDeps {
  pool: pg.Pool;
  clock: Clock;
  /**
   * Whether the session cookie carries `Secure`. True everywhere it matters;
   * settable only so a local stack served over plain HTTP can still sign in.
   */
  cookieSecure: boolean;
}

declare module "fastify" {
  interface FastifyInstance {
    // Named for this service rather than a bare `deps`, because the two
    // deployables' Fastify augmentations meet in the cross-surface test — one
    // program, two apps, and a shared property name would be a type conflict.
    adminDeps: AdminAppDeps;
  }
}

export function buildAdminApp(deps: AdminAppDeps): FastifyInstance {
  const app = Fastify({ logger: false });
  app.decorate("adminDeps", deps);

  // The session cookie is the whole authentication scheme here.
  app.register(cookie);

  // No CORS plugin, deliberately: the panel is served same-origin with this API,
  // so there is no cross-origin caller to allow. An origin-reflecting policy
  // here (as the Client API runs) would undo what `SameSite=Strict` is for.

  app.register(registerAuthRoutes);
  app.register(registerBrandingRoutes);
  app.register(registerClientRoutes);
  app.register(registerPlanRoutes);
  app.register(registerTimezoneRoutes);
  app.register(registerUserRoutes);

  // A liveness probe that proves the one thing this service needs to be up:
  // that it can reach the database.
  app.get("/api/health", async () => {
    const { pool, clock } = app.adminDeps;
    await pool.query("SELECT 1");
    return { status: "ok", time: clock.now().toISOString() };
  });

  return app;
}
