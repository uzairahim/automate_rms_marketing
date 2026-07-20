import { Worker } from "bullmq";
import type pg from "pg";
import type { RedisOptions } from "ioredis";
import type { Clock } from "../core/clock.js";
import { purgeDueMedia } from "../media/media.js";
import { MEDIA_PURGE_QUEUE_NAME, type MediaPurgeJobData } from "../queue/media-purge-queue.js";

/**
 * The worker side of the Media-purge tick. Deliberately thin: it is the
 * adapter between BullMQ and {@link purgeDueMedia}, which holds all the
 * behavior and is tested directly.
 */
export function startMediaPurgeWorker(deps: {
  pool: pg.Pool;
  clock: Clock;
  mediaDir: string;
  connection: RedisOptions;
}): Worker<MediaPurgeJobData> {
  return new Worker<MediaPurgeJobData>(
    MEDIA_PURGE_QUEUE_NAME,
    async () => {
      const purged = await purgeDueMedia(deps.pool, deps.clock, deps.mediaDir);
      if (purged) console.log(`[media-purge] purged ${purged} media file(s)`);
      return { purged };
    },
    { connection: deps.connection },
  );
}
