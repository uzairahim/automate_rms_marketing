import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import type pg from "pg";
import { Queue } from "bullmq";
import type { Clock } from "./core/clock.js";
import type { Publisher } from "./core/publisher.js";
import { type HealthJobData } from "./queue/health-queue.js";
import { registerSuperadminRoutes } from "./routes/admin.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerPlatformRoutes } from "./routes/platforms.js";

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
  /** Base domain for subdomain routing (e.g. `ourapp.com`, or `localhost` in dev). */
  baseDomain: string;
  /** Shared secret gating the Superadmin `admin.` surface. */
  superadminToken: string;
  /** The health queue. Optional so pure-HTTP tests can omit Redis entirely. */
  healthQueue?: Queue<HealthJobData>;
}

declare module "fastify" {
  interface FastifyInstance {
    deps: AppDeps;
  }
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: false });
  app.decorate("deps", deps);

  app.register(cors, { origin: true });

  // The tenancy spine (Slice 2): Superadmin provisioning on the `admin.` surface
  // and Client-scoped User login on each Client subdomain.
  app.register(registerSuperadminRoutes);
  app.register(registerAuthRoutes);
  // Plan-gated platform surface (Slice 3): what a Client's Plan lets it see/act on.
  app.register(registerPlatformRoutes);

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
