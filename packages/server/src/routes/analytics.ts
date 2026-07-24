import type { FastifyInstance } from "fastify";
import { authenticateClientRequest } from "../auth/guards.js";
import { accountAnalytics } from "../analytics/metric-snapshots.js";

/**
 * The account-level analytics dashboard (Slice 12; ADR 0004).
 *
 * `GET /api/analytics` returns one trend per connected platform — an ordered
 * series of daily points (followers, reach, engagement, posts published) read
 * straight from our own stored snapshots, so the dashboard loads instantly and
 * charts every platform the same way. It reflects only what the Client has
 * connected right now, and a platform with no snapshots yet comes back with an
 * empty series rather than being dropped (there is no pre-connection backfill).
 *
 * The snapshots themselves are written by the daily job
 * ({@link ../analytics/snapshot-job.ts}); this route is a pure read.
 */
export async function registerAnalyticsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/analytics", async (request, reply) => {
    const ctx = await authenticateClientRequest(request, reply);
    if (!ctx) return reply;

    const { pool } = app.deps;
    const accounts = await accountAnalytics(pool, ctx.client.id);
    return reply.code(200).send({ accounts });
  });
}
