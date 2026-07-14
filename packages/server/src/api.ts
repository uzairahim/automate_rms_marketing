import "./load-env.js";
import { Queue } from "bullmq";
import { loadConfig } from "./config.js";
import { createPool, waitForPostgres } from "./db/pool.js";
import { runMigrations } from "./db/migrate.js";
import { buildApp } from "./app.js";
import { SystemClock } from "./core/clock.js";
import { FakePublisher } from "./core/fake-publisher.js";
import {
  HEALTH_QUEUE_NAME,
  redisConnection,
  type HealthJobData,
} from "./queue/health-queue.js";

/**
 * API process entrypoint. Wires the real dependencies and starts listening.
 *
 * The Publisher is still the {@link FakePublisher} in Slice 1 — the real
 * per-platform transports arrive with the connect flow (Slice 6+). The seam is
 * in place, so swapping it later touches only this wiring.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  await waitForPostgres(pool);
  await runMigrations(pool);

  const healthQueue = new Queue<HealthJobData>(HEALTH_QUEUE_NAME, {
    connection: redisConnection(config.redisUrl),
  });

  const app = buildApp({
    pool,
    clock: new SystemClock(),
    publisher: new FakePublisher(),
    healthQueue,
  });

  await app.listen({ port: config.apiPort, host: "0.0.0.0" });
  console.log(`API listening on :${config.apiPort}`);

  const shutdown = async () => {
    await app.close();
    await healthQueue.close();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
