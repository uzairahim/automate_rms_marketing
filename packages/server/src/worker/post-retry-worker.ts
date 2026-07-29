import { Worker } from "bullmq";
import type pg from "pg";
import type { RedisOptions } from "ioredis";
import type { Clock } from "../core/clock.js";
import type { Publisher } from "../core/publisher.js";
import type { SecretCipher } from "../core/crypto.js";
import { retryDueTargets } from "../posts/retry.js";
import { POST_RETRY_QUEUE_NAME, type PostRetryJobData } from "../queue/post-retry-queue.js";

/**
 * The worker side of the Post-retry tick. Deliberately thin: it is the adapter
 * between BullMQ and {@link retryDueTargets}, which holds all the behavior and
 * is tested directly.
 */
export function startPostRetryWorker(deps: {
  pool: pg.Pool;
  clock: Clock;
  publisher: Publisher;
  tokenCipher: SecretCipher;
  mediaDir: string;
  connection: RedisOptions;
}): Worker<PostRetryJobData> {
  return new Worker<PostRetryJobData>(
    POST_RETRY_QUEUE_NAME,
    async () => {
      const outcome = await retryDueTargets(
        deps.pool,
        deps.clock,
        deps.publisher,
        deps.tokenCipher,
        deps.mediaDir,
      );
      if (outcome.attempted) {
        console.log(
          `[post-retry] attempted ${outcome.attempted} targets ` +
            `(${outcome.published} published, ${outcome.failed} failed)`,
        );
      }
      return outcome;
    },
    { connection: deps.connection },
  );
}
