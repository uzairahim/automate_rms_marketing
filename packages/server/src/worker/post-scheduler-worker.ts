import { Worker } from "bullmq";
import type pg from "pg";
import type { RedisOptions } from "ioredis";
import type { Clock } from "../core/clock.js";
import type { Publisher } from "../core/publisher.js";
import type { SecretCipher } from "../core/crypto.js";
import { publishDuePosts } from "../posts/scheduling.js";
import {
  POST_SCHEDULER_QUEUE_NAME,
  type PostSchedulerJobData,
} from "../queue/post-scheduler-queue.js";

/**
 * The worker side of the Post-scheduler tick. Deliberately thin: it is the
 * adapter between BullMQ and {@link publishDuePosts}, which holds all the
 * behavior and is tested directly.
 */
export function startPostSchedulerWorker(deps: {
  pool: pg.Pool;
  clock: Clock;
  publisher: Publisher;
  tokenCipher: SecretCipher;
  mediaDir: string;
  connection: RedisOptions;
}): Worker<PostSchedulerJobData> {
  return new Worker<PostSchedulerJobData>(
    POST_SCHEDULER_QUEUE_NAME,
    async () => {
      const outcome = await publishDuePosts(
        deps.pool,
        deps.clock,
        deps.publisher,
        deps.tokenCipher,
        deps.mediaDir,
      );
      if (outcome.due) {
        console.log(
          `[post-scheduler] ${outcome.due} due (${outcome.fired} fired, ${outcome.missed} missed, ${outcome.blocked} blocked)`,
        );
      }
      return outcome;
    },
    { connection: deps.connection },
  );
}
