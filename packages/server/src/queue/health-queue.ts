import type { RedisOptions } from "ioredis";

/**
 * The trivial "health" queue for Slice 1: it proves an enqueued BullMQ job is
 * processed end-to-end by the worker (which writes a row to `job_runs`). Later
 * slices add the three real recurring queues (minute scheduler, token refresh,
 * daily metric snapshot).
 */
export const HEALTH_QUEUE_NAME = "health";

export interface HealthJobData {
  /** Echoed into the `job_runs` payload so a test can correlate it. */
  note: string;
}

/**
 * BullMQ needs a Redis connection with `maxRetriesPerRequest: null`. We pass a
 * connection options object (not a shared client) so BullMQ owns its own
 * connections and lifecycle.
 */
export function redisConnection(redisUrl: string): RedisOptions {
  const url = new URL(redisUrl);
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    ...(url.password ? { password: url.password } : {}),
    maxRetriesPerRequest: null,
  };
}
