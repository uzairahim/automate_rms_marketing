import "./load-env.js";
import { Queue } from "bullmq";
import { createPool, waitForPostgres } from "@smma/core";
import { loadConfig } from "./config.js";
import { runMigrations } from "./db/migrate.js";
import { buildApp } from "./app.js";
import { SystemClock } from "./core/clock.js";
import { ConsoleEmailSender, ResendEmailSender, type EmailSender } from "./core/email.js";
import { createSecretCipher, parseEncryptionKey } from "./core/crypto.js";
import { resolvePublisher } from "./platforms/resolve-publisher.js";
import {
  HEALTH_QUEUE_NAME,
  redisConnection,
  type HealthJobData,
} from "./queue/health-queue.js";

/**
 * API process entrypoint. Wires the real dependencies and starts listening.
 *
 * Every seam is resolved here and injected — the Publisher transport, the token
 * cipher, the email sender — so nothing downstream reaches for a global or reads
 * the environment for itself.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  await waitForPostgres(pool);
  await runMigrations(pool);

  const healthQueue = new Queue<HealthJobData>(HEALTH_QUEUE_NAME, {
    connection: redisConnection(config.redisUrl),
  });

  // Real mail via Resend when a provider key is configured; otherwise the
  // console sender logs the reset link so local dev needs no provider wiring.
  const emailSender: EmailSender = config.email.resendApiKey
    ? new ResendEmailSender(config.email.resendApiKey, config.email.from)
    : new ConsoleEmailSender();

  const clock = new SystemClock();
  const app = buildApp({
    pool,
    clock,
    publisher: resolvePublisher(config, clock),
    emailSender,
    // Fails fast at startup on a bad key, rather than at the first connect.
    tokenCipher: createSecretCipher(parseEncryptionKey(config.tokenEncryptionKey)),
    baseDomain: config.baseDomain,
    superadminToken: config.superadminToken,
    oauthRedirectBaseUrl: config.oauthRedirectBaseUrl,
    metaAppSecret: config.meta.appSecret,
    healthQueue,
    mediaDir: config.mediaDir,
    mediaBaseUrl: config.mediaBaseUrl,
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
