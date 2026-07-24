import { Queue } from "bullmq";
// From ioredis, not bullmq (their RedisOptions are structurally incompatible) —
// see token-refresh-queue.ts for the same note.
import type { RedisOptions } from "ioredis";

/**
 * The daily metric-snapshot queue (ADR 0004) — the third recurring job, after
 * token refresh and the minute scheduler.
 *
 * The queue only triggers the tick on a schedule; all the behavior lives in
 * {@link ../analytics/snapshot-job.ts}, exercised directly by tests. Nothing about
 * the work is held in Redis: each run re-queries which accounts are connected, so
 * a missed night costs only that day's points, never a stuck schedule.
 */
export const METRIC_SNAPSHOT_QUEUE_NAME = "metric-snapshot";

/** The job carries no data — the tick itself is the whole message. */
export type MetricSnapshotJobData = Record<string, never>;

/**
 * Once a day, in the small hours (03:00 server time). A daily grain means the
 * exact minute does not matter; a quiet hour keeps the burst of platform reads
 * away from peak publishing. The snapshot's *date* is resolved per Client in its
 * own timezone (see `snapshotDateFor`), so this one server-time tick still files
 * each Client's point under the right calendar day.
 */
export const METRIC_SNAPSHOT_CRON = "0 3 * * *";

/**
 * Register the recurring tick. Idempotent under its job id: restarting the worker
 * re-registers the same schedule rather than stacking up duplicates.
 */
export async function scheduleMetricSnapshot(
  connection: RedisOptions,
): Promise<Queue<MetricSnapshotJobData>> {
  const queue = new Queue<MetricSnapshotJobData>(METRIC_SNAPSHOT_QUEUE_NAME, { connection });
  await queue.add(
    "record-daily-snapshots",
    {},
    {
      repeat: { pattern: METRIC_SNAPSHOT_CRON },
      jobId: "metric-snapshot-tick",
      removeOnComplete: true,
      removeOnFail: 100,
    },
  );
  return queue;
}
