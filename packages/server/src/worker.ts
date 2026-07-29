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
import { schedulePostRetry } from "./queue/post-retry-queue.js";
import { startPostRetryWorker } from "./worker/post-retry-worker.js";
import { scheduleMediaPurge } from "./queue/media-purge-queue.js";
import { startMediaPurgeWorker } from "./worker/media-purge-worker.js";
import { schedulePostScheduler } from "./queue/post-scheduler-queue.js";
import { startPostSchedulerWorker } from "./worker/post-scheduler-worker.js";
import { scheduleMetricSnapshot } from "./queue/metric-snapshot-queue.js";
import { startMetricSnapshotWorker } from "./worker/metric-snapshot-worker.js";

/**
 * Worker process entrypoint. It runs the recurring jobs the PRD calls for: the
 * token-refresh job arrives with the connect flow (Slice 6), the minute
 * scheduler with Slice 10, and the daily metric snapshot with Slice 12.
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
  const cipher = createSecretCipher(parseEncryptionKey(config.tokenEncryptionKey));
  const tokenRefreshQueue = await scheduleTokenRefresh(connection);
  const publisher = resolvePublisher(config, clock);
  const tokenRefreshWorker = startTokenRefreshWorker({
    pool,
    clock,
    cipher,
    publisher,
    connection,
  });

  // Auto-retries a failed Target twice at one-minute intervals (Slice 8).
  const postRetryQueue = await schedulePostRetry(connection);
  const postRetryWorker = startPostRetryWorker({
    pool,
    clock,
    publisher,
    tokenCipher: cipher,
    mediaDir: config.mediaDir,
    connection,
  });

  // Purges Media 24 hours after a partial/total publish failure (Slice 9;
  // ADR 0003). Immediate purges on full success happen inline when a Post's
  // Target roll-up settles, so this tick only ever finds the delayed case.
  const mediaPurgeQueue = await scheduleMediaPurge(connection);
  const mediaPurgeWorker = startMediaPurgeWorker({ pool, clock, mediaDir: config.mediaDir, connection });

  // Fires due Scheduled Posts on a minute tick, marking a badly-late one
  // Failed instead (Slice 10; PRD stories 35, 44–45).
  const postSchedulerQueue = await schedulePostScheduler(connection);
  const postSchedulerWorker = startPostSchedulerWorker({
    pool,
    clock,
    publisher,
    tokenCipher: cipher,
    mediaDir: config.mediaDir,
    connection,
  });

  // Snapshots each connected account's account-level numbers once a day, so the
  // dashboard can trend them over time (Slice 12; ADR 0004). Reads through the
  // same Publisher seam, injected identically to the other jobs.
  const metricSnapshotQueue = await scheduleMetricSnapshot(connection);
  const metricSnapshotWorker = startMetricSnapshotWorker({
    pool,
    clock,
    cipher,
    publisher,
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
  postRetryWorker.on("ready", () => console.log("Post retry worker ready"));
  postRetryWorker.on("failed", (job, err) =>
    console.error(`Post retry job ${job?.id} failed:`, err),
  );
  mediaPurgeWorker.on("ready", () => console.log("Media purge worker ready"));
  mediaPurgeWorker.on("failed", (job, err) =>
    console.error(`Media purge job ${job?.id} failed:`, err),
  );
  postSchedulerWorker.on("ready", () => console.log("Post scheduler worker ready"));
  postSchedulerWorker.on("failed", (job, err) =>
    console.error(`Post scheduler job ${job?.id} failed:`, err),
  );
  metricSnapshotWorker.on("ready", () => console.log("Metric snapshot worker ready"));
  metricSnapshotWorker.on("failed", (job, err) =>
    console.error(`Metric snapshot job ${job?.id} failed:`, err),
  );

  const shutdown = async () => {
    await healthWorker.close();
    await tokenRefreshWorker.close();
    await tokenRefreshQueue.close();
    await postRetryWorker.close();
    await postRetryQueue.close();
    await mediaPurgeWorker.close();
    await mediaPurgeQueue.close();
    await postSchedulerWorker.close();
    await postSchedulerQueue.close();
    await metricSnapshotWorker.close();
    await metricSnapshotQueue.close();
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
