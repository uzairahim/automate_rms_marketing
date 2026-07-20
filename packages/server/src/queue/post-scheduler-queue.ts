import { Queue } from "bullmq";
import type { RedisOptions } from "ioredis";

/**
 * The Post-scheduler queue — triggers {@link ../posts/scheduling.js}'s
 * due-query minute tick (PRD: "on each minute tick", issue #11).
 *
 * Like the post-retry queue, this only exists to schedule the tick; all the
 * behavior lives in `publishDuePosts`, tested directly. Nothing about a
 * schedule is held in Redis — each tick re-queries which Posts are due, so a
 * restart never drops a schedule (it only costs time, bounded by the
 * 60-minute grace window).
 */
export const POST_SCHEDULER_QUEUE_NAME = "post-scheduler";

/** The job carries no data — the tick itself is the whole message. */
export type PostSchedulerJobData = Record<string, never>;

/** Once a minute, matching the PRD's "minute tick" in full. */
export const POST_SCHEDULER_INTERVAL_MS = 60_000;

/**
 * Register the recurring tick. Idempotent under its job id: restarting the
 * worker re-registers the same schedule rather than stacking up duplicates.
 */
export async function schedulePostScheduler(
  connection: RedisOptions,
): Promise<Queue<PostSchedulerJobData>> {
  const queue = new Queue<PostSchedulerJobData>(POST_SCHEDULER_QUEUE_NAME, { connection });
  await queue.add(
    "publish-due-posts",
    {},
    {
      repeat: { every: POST_SCHEDULER_INTERVAL_MS },
      jobId: "post-scheduler-tick",
      removeOnComplete: true,
      removeOnFail: 100,
    },
  );
  return queue;
}
