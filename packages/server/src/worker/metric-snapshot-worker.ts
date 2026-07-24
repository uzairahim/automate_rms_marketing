import { Worker } from "bullmq";
import type pg from "pg";
import type { RedisOptions } from "ioredis";
import type { Clock } from "../core/clock.js";
import type { SecretCipher } from "../core/crypto.js";
import type { Publisher } from "../core/publisher.js";
import { recordDailySnapshots } from "../analytics/snapshot-job.js";
import {
  METRIC_SNAPSHOT_QUEUE_NAME,
  type MetricSnapshotJobData,
} from "../queue/metric-snapshot-queue.js";

/**
 * The worker side of the daily metric-snapshot tick. Deliberately thin: it is the
 * adapter between BullMQ and {@link recordDailySnapshots}, which holds all the
 * behavior and is tested directly. Returns the {@link Worker} so the caller owns
 * its lifecycle.
 */
export function startMetricSnapshotWorker(deps: {
  pool: pg.Pool;
  clock: Clock;
  cipher: SecretCipher;
  publisher: Publisher;
  connection: RedisOptions;
}): Worker<MetricSnapshotJobData> {
  return new Worker<MetricSnapshotJobData>(
    METRIC_SNAPSHOT_QUEUE_NAME,
    async () => {
      const outcome = await recordDailySnapshots(
        deps.pool,
        deps.clock,
        deps.cipher,
        deps.publisher,
      );
      if (outcome.recorded || outcome.skipped) {
        console.log(
          `[metric-snapshot] recorded ${outcome.recorded}, skipped ${outcome.skipped}`,
        );
      }
      return outcome;
    },
    { connection: deps.connection },
  );
}
