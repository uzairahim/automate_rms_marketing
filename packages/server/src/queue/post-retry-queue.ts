import { Queue } from "bullmq";
import type { RedisOptions } from "ioredis";

/**
 * The Post-retry queue — triggers {@link ../posts/retry.js}'s due-query tick.
 *
 * Like the token-refresh queue, this only exists to schedule the tick; all the
 * behavior lives in `retryDueTargets`, tested directly. Nothing about a
 * scheduled retry is held in Redis — each tick re-queries which Targets are
 * due, so a missed tick only costs time, never a dropped retry.
 */
export const POST_RETRY_QUEUE_NAME = "post-retry";

/** The job carries no data — the tick itself is the whole message. */
export type PostRetryJobData = Record<string, never>;

/**
 * Every 15 seconds. Retries are spaced a minute apart, so a tick well under
 * that keeps a Target's retry prompt without hammering the due-query. A plain
 * millisecond `every` is used rather than the token-refresh queue's cron
 * `pattern`, because cron's finest grain is one minute and cannot express
 * this tick at all.
 */
export const POST_RETRY_INTERVAL_MS = 15_000;

/**
 * Register the recurring tick. Idempotent under its job id: restarting the
 * worker re-registers the same schedule rather than stacking up duplicates.
 */
export async function schedulePostRetry(connection: RedisOptions): Promise<Queue<PostRetryJobData>> {
  const queue = new Queue<PostRetryJobData>(POST_RETRY_QUEUE_NAME, { connection });
  await queue.add(
    "retry-due-targets",
    {},
    {
      repeat: { every: POST_RETRY_INTERVAL_MS },
      jobId: "post-retry-tick",
      removeOnComplete: true,
      removeOnFail: 100,
    },
  );
  return queue;
}
