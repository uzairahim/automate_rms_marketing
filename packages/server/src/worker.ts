import "./load-env.js";
import { loadConfig } from "./config.js";
import { createPool, waitForPostgres } from "./db/pool.js";
import { runMigrations } from "./db/migrate.js";
import { redisConnection } from "./queue/health-queue.js";
import { startHealthWorker } from "./worker/health-worker.js";
import { SystemClock } from "./core/clock.js";
import { createSecretCipher, parseEncryptionKey } from "./core/crypto.js";
import { resolvePublisher } from "./platforms/resolve-publisher.js";
import { scheduleTokenRefresh } from "./queue/token-refresh-queue.js";
import { startTokenRefreshWorker } from "./worker/token-refresh-worker.js";

/**
 * Worker process entrypoint. It runs the recurring jobs the PRD calls for: the
 * token-refresh job arrives with the connect flow (Slice 6), and the minute
 * scheduler and daily metric snapshot follow in later slices.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  await waitForPostgres(pool);
  await runMigrations(pool);

  const connection = redisConnection(config.redisUrl);
  const healthWorker = startHealthWorker(pool, connection);

  // Keeps every connected Page's token valid ahead of expiry (ADR 0002). The
  // same seams the API wires, injected identically here.
  const clock = new SystemClock();
  const tokenRefreshQueue = await scheduleTokenRefresh(connection);
  const tokenRefreshWorker = startTokenRefreshWorker({
    pool,
    clock,
    cipher: createSecretCipher(parseEncryptionKey(config.tokenEncryptionKey)),
    publisher: resolvePublisher(config, clock),
    connection,
  });

  healthWorker.on("ready", () => console.log("Health worker ready"));
  healthWorker.on("failed", (job, err) =>
    console.error(`Job ${job?.id} failed:`, err),
  );
  tokenRefreshWorker.on("ready", () => console.log("Token refresh worker ready"));
  tokenRefreshWorker.on("failed", (job, err) =>
    console.error(`Token refresh job ${job?.id} failed:`, err),
  );

  const shutdown = async () => {
    await healthWorker.close();
    await tokenRefreshWorker.close();
    await tokenRefreshQueue.close();
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
