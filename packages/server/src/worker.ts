import "./load-env.js";
import { loadConfig } from "./config.js";
import { createPool, waitForPostgres } from "./db/pool.js";
import { runMigrations } from "./db/migrate.js";
import { redisConnection } from "./queue/health-queue.js";
import { startHealthWorker } from "./worker/health-worker.js";

/**
 * Worker process entrypoint. In Slice 1 it runs only the health worker; later
 * slices register the three recurring jobs (minute scheduler, token refresh,
 * daily metric snapshot) here.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  await waitForPostgres(pool);
  await runMigrations(pool);

  const connection = redisConnection(config.redisUrl);
  const healthWorker = startHealthWorker(pool, connection);

  healthWorker.on("ready", () => console.log("Health worker ready"));
  healthWorker.on("failed", (job, err) =>
    console.error(`Job ${job?.id} failed:`, err),
  );

  const shutdown = async () => {
    await healthWorker.close();
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
