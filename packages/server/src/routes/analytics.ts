import type { FastifyInstance } from "fastify";
import { authenticateClientRequest } from "../auth/guards.js";
import { accountAnalytics } from "../analytics/metric-snapshots.js";
import { postActivity } from "../analytics/post-activity.js";
import { analyticsRange, rangeDaysFromQuery } from "../analytics/range.js";

/**
 * The dashboard's one read (Slice 12; ADR 0004).
 *
 * `GET /api/analytics?days=30` answers both halves of the screen in a single
 * round-trip, cut to a single window:
 *
 *   - `accounts` — one trend per connected platform, an ordered series of daily
 *     points (followers, reach, engagement, posts published) read straight from
 *     our own stored snapshots, so the dashboard loads instantly and charts every
 *     platform the same way. It reflects only what the Client has connected right
 *     now, and a platform with no snapshots in the window comes back with an empty
 *     series rather than being dropped (there is no pre-connection backfill).
 *   - `posts` — what this Client actually published, counted out of our own
 *     records: deliveries per day, outcomes per platform, and what is still queued.
 *
 * One route rather than two because the dashboard's range control has to move
 * both halves together — two endpoints would let the audience chart and the
 * publishing chart drift onto different windows mid-render.
 *
 * Both halves are pure reads with no platform round-trip. The snapshots are
 * written by the daily job ({@link ../analytics/snapshot-job.ts}); the publishing
 * numbers are a by-product of Targets settling.
 */
export async function registerAnalyticsRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { days?: string } }>("/api/analytics", async (request, reply) => {
    const ctx = await authenticateClientRequest(request, reply);
    if (!ctx) return reply;

    const { pool, clock } = app.deps;
    // The window is resolved in the Client's timezone, which is what makes "the
    // last 30 days" mean the same thing here as on the screen showing it.
    const range = analyticsRange(
      clock.now(),
      ctx.client.timezone,
      rangeDaysFromQuery(request.query.days),
    );

    const [accounts, posts] = await Promise.all([
      accountAnalytics(pool, ctx.client.id, range),
      postActivity(pool, ctx.client.id, ctx.client.timezone, range),
    ]);

    return reply.code(200).send({ range, accounts, posts });
  });
}
