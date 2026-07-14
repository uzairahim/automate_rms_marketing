import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import type { RedisOptions } from "ioredis";

export interface TestRedis {
  connection: RedisOptions;
  stop(): Promise<void>;
}

/**
 * Spin up an ephemeral Redis in Docker and return BullMQ-ready connection
 * options. Used by tests that exercise the queue/worker round-trip.
 */
export async function startTestRedis(): Promise<TestRedis> {
  const container: StartedRedisContainer = await new RedisContainer(
    "redis:7",
  ).start();

  return {
    connection: {
      host: container.getHost(),
      port: container.getMappedPort(6379),
      maxRetriesPerRequest: null,
    },
    async stop() {
      await container.stop();
    },
  };
}
