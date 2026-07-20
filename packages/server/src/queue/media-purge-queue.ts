import { Queue } from "bullmq";
import type { RedisOptions } from "ioredis";

/**
 * The Media-purge queue — triggers {@link ../media/media.js}'s due-query tick
 * (Slice 9; ADR 0003).
 *
 * Like the Post-retry queue, this only exists to schedule the tick; all the
 * behavior lives in `purgeDueMedia`, tested directly. Nothing about a
 * scheduled purge is held in Redis — each tick re-queries which Media is due,
 * so a missed tick only costs time, never a dropped purge.
 */
export const MEDIA_PURGE_QUEUE_NAME = "media-purge";

/** The job carries no data — the tick itself is the whole message. */
export type MediaPurgeJobData = Record<string, never>;

/**
 * Every 5 minutes. The purge window itself is 24 hours, so there is no need
 * for a tight tick the way the 1-minute-spaced retry chain needs one.
 */
export const MEDIA_PURGE_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Register the recurring tick. Idempotent under its job id: restarting the
 * worker re-registers the same schedule rather than stacking up duplicates.
 */
export async function scheduleMediaPurge(connection: RedisOptions): Promise<Queue<MediaPurgeJobData>> {
  const queue = new Queue<MediaPurgeJobData>(MEDIA_PURGE_QUEUE_NAME, { connection });
  await queue.add(
    "purge-due-media",
    {},
    {
      repeat: { every: MEDIA_PURGE_INTERVAL_MS },
      jobId: "media-purge-tick",
      removeOnComplete: true,
      removeOnFail: 100,
    },
  );
  return queue;
}
