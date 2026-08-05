import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import formbody from "@fastify/formbody";
import type pg from "pg";
import { Queue } from "bullmq";
import type { Clock } from "./core/clock.js";
import type { Publisher } from "./core/publisher.js";
import type { EmailSender } from "./core/email.js";
import type { SecretCipher } from "./core/crypto.js";
import { type HealthJobData } from "./queue/health-queue.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerPlatformRoutes } from "./routes/platforms.js";
import { registerBrandingRoutes } from "./routes/branding.js";
import { registerConnectionRoutes } from "./routes/connections.js";
import { registerWebhookRoutes } from "./routes/webhooks.js";
import { registerPostRoutes } from "./routes/posts.js";
import { registerMediaRoutes } from "./routes/media.js";
import { registerAnalyticsRoutes } from "./routes/analytics.js";

/**
 * Everything the HTTP app depends on, injected at construction. This is what
 * makes the app testable: tests pass a pool pointed at an ephemeral Postgres, a
 * {@link TestClock}, a {@link FakePublisher}, and a real BullMQ queue pointed at
 * an ephemeral Redis — then drive the app with Fastify's `inject()` as a real
 * client. No global singletons.
 */
export interface AppDeps {
  pool: pg.Pool;
  clock: Clock;
  publisher: Publisher;
  /** Sends transactional email (password-reset links). Faked in tests. */
  emailSender: EmailSender;
  /**
   * Encrypts platform tokens at rest (ADR 0006). Its key comes from the
   * environment, never the DB — injected here so it is never a global.
   */
  tokenCipher: SecretCipher;
  /** Base domain for subdomain routing (e.g. `ourapp.com`, or `localhost` in dev). */
  baseDomain: string;
  /**
   * Origin of the canonical OAuth callback surface (e.g.
   * `https://connect.ourapp.com`). One fixed redirect URI per platform is
   * derived from it — Meta will not whitelist a wildcard, so every Client's
   * handshake comes back through this one host and is re-tenanted from the
   * `oauth_states` row rather than from the host it landed on.
   */
  oauthRedirectBaseUrl: string;
  /**
   * Our Meta app secret. Only Meta and we know it, which is what lets the public
   * deauthorization callback verify that a request really is Meta's. Read from
   * the environment / a secrets manager, never committed (ADR 0006).
   *
   * Optional because a local checkout has no Meta app. Absent, the callback
   * refuses everything rather than verifying against an empty secret — a
   * signature anyone could compute is worse than no endpoint at all.
   */
  metaAppSecret?: string;
  /** The health queue. Optional so pure-HTTP tests can omit Redis entirely. */
  healthQueue?: Queue<HealthJobData>;
  /**
   * Directory on this server's disk where uploaded Media files live (Slice 9;
   * ADR 0003 — no object store).
   */
  mediaDir: string;
  /** This API's own public HTTPS origin, used to build a Media's fetch URL. */
  mediaBaseUrl: string;
}

declare module "fastify" {
  interface FastifyInstance {
    deps: AppDeps;
  }
}

export function buildApp(deps: AppDeps): FastifyInstance {
  // Raised from Fastify's 1MB default to leave room for an uploaded image/video
  // (Slice 9) — small enough to keep a single misbehaving upload from starving
  // the process, since Media is served straight off this server's own disk.
  const app = Fastify({ logger: false, bodyLimit: 25 * 1024 * 1024 });
  app.decorate("deps", deps);

  app.register(cors, { origin: true });
  // Meta posts its callbacks form-encoded, not as JSON.
  app.register(formbody);
  // Media uploads (Slice 9) arrive as a raw body under whatever Content-Type
  // the caller sends — including one we reject (e.g. `audio/*`), which the
  // upload route needs to see and answer with its own 400, not Fastify's
  // generic 415. Catch-all: only applies where no more specific parser (JSON,
  // form-encoded) is already registered, so those are unaffected.
  app.addContentTypeParser("*", { parseAs: "buffer" }, (_request, body, done) => {
    done(null, body);
  });

  // The tenancy spine (Slice 2): Client-scoped User login on each Client
  // subdomain. Provisioning is deliberately absent — it lives in `@smma/admin`,
  // in a process of its own (ADR 0010), so nothing reachable here can create a
  // Client, issue a credential, or suspend anyone.
  app.register(registerAuthRoutes);
  // Plan-gated platform surface (Slice 3): what a Client's Plan lets it see/act on.
  app.register(registerPlatformRoutes);
  // Public white-label branding surface (Slice 5): resolved from the subdomain,
  // fetched by the SPA at load so the app looks like the Client's own tool.
  app.register(registerBrandingRoutes);
  // Connected Accounts (Slice 6): the OAuth connect flow, connection status, and
  // the platform callbacks that end a connection from the platform's side.
  app.register(registerConnectionRoutes);
  app.register(registerWebhookRoutes);
  // Compose + validate-and-gate + immediate publish (Slice 8): a Post fans out
  // to one Target per selected platform through the same Publisher seam.
  app.register(registerPostRoutes);
  // Media upload + public serve (Slice 9; ADR 0003): stored on this server's
  // own disk, ephemeral, purged once a Post's Targets have all settled.
  app.register(registerMediaRoutes);
  // Account-level analytics dashboard (Slice 12; ADR 0004): trends read from the
  // daily snapshots the worker records, one series per connected platform.
  app.register(registerAnalyticsRoutes);

  app.get("/api/health", async () => {
    const { pool, clock } = app.deps;
    const result = await pool.query<{ status: string }>(
      "SELECT status FROM health_check WHERE id = 1",
    );
    const status = result.rows[0]?.status ?? "unknown";
    return {
      status,
      time: clock.now().toISOString(),
    };
  });

  // Enqueue a trivial job so the worker round-trip can be exercised from the API.
  app.post<{ Body: { note?: string } }>("/api/health/enqueue", async (request, reply) => {
    const queue = app.deps.healthQueue;
    if (!queue) {
      return reply.code(503).send({ error: "queue not configured" });
    }
    const note = request.body?.note ?? "ping";
    const job = await queue.add("health", { note });
    return reply.code(202).send({ jobId: job.id, note });
  });

  return app;
}
