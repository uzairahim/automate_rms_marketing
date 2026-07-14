import { Worker } from "bullmq";
import type pg from "pg";
import type { RedisOptions } from "ioredis";
import {
  HEALTH_QUEUE_NAME,
  type HealthJobData,
} from "../queue/health-queue.js";

/**
 * The worker side of the trivial health round-trip: it consumes `health` jobs
 * and records each one in `job_runs`. Returns the BullMQ {@link Worker} so the
 * caller (process entrypoint or test) owns its lifecycle and can `close()` it.
 */
export function startHealthWorker(
  pool: pg.Pool,
  connection: RedisOptions,
): Worker<HealthJobData> {
  return new Worker<HealthJobData>(
    HEALTH_QUEUE_NAME,
    async (job) => {
      await pool.query(
        "INSERT INTO job_runs (job_name, payload) VALUES ($1, $2)",
        [job.name, JSON.stringify(job.data)],
      );
    },
    { connection },
  );
}
