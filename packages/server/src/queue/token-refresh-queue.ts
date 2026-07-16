import { Queue } from "bullmq";
// From ioredis, not bullmq: bullmq bundles its own copy of ioredis, and the two
// RedisOptions types are structurally incompatible. The rest of the queue code
// types these the same way.
import type { RedisOptions } from "ioredis";

/**
 * The token-refresh queue (ADR 0002: "we run token refresh ourselves") — the
 * first of the three recurring jobs the PRD calls for.
 *
 * The queue exists only to trigger the job on a schedule; all of the behavior
 * lives in {@link ../connections/token-refresh.ts}, which is exercised directly
 * by tests. Nothing about the work is held in Redis: each tick re-queries which
 * accounts are due, so a missed tick costs nothing but time.
 */
export const TOKEN_REFRESH_QUEUE_NAME = "token-refresh";

/** The job carries no data — the tick itself is the whole message. */
export type TokenRefreshJobData = Record<string, never>;

/**
 * Hourly. The refresh window is a week wide, so the tick rate only decides how
 * promptly we notice, not whether we make it in time — and a token that fails to
 * refresh is not going to start working if we ask every minute.
 */
export const TOKEN_REFRESH_CRON = "0 * * * *";

/**
 * Register the recurring tick. Idempotent under its job id: restarting the
 * worker re-registers the same schedule rather than stacking up duplicates.
 */
export async function scheduleTokenRefresh(
  connection: RedisOptions,
): Promise<Queue<TokenRefreshJobData>> {
  const queue = new Queue<TokenRefreshJobData>(TOKEN_REFRESH_QUEUE_NAME, { connection });
  await queue.add(
    "refresh-due-tokens",
    {},
    {
      repeat: { pattern: TOKEN_REFRESH_CRON },
      jobId: "token-refresh-tick",
      removeOnComplete: true,
      removeOnFail: 100,
    },
  );
  return queue;
}
