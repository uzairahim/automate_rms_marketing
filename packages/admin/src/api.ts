import "./load-env.js";
import { loadAdminConfig } from "./config.js";
import { createPool, waitForPostgres } from "./db/pool.js";
import { runAdminMigrations } from "./db/migrate.js";
import { buildAdminApp } from "./app.js";
import { SystemClock } from "./clock.js";

/**
 * The Superadmin API process — its own deployable, so it can live on a host of
 * its own and stay off the public internet entirely if the operator wants
 * (ADR 0010).
 *
 * It applies its own migrations on boot, which is what lets it stand itself up
 * against a database without the Client-facing service having been deployed
 * first.
 */
async function main(): Promise<void> {
  const config = loadAdminConfig();
  const pool = createPool(config.databaseUrl);
  await waitForPostgres(pool);
  await runAdminMigrations(pool);

  const app = buildAdminApp({
    pool,
    clock: new SystemClock(),
    cookieSecure: config.cookieSecure,
  });

  await app.listen({ port: config.apiPort, host: "0.0.0.0" });
  console.log(`Admin API listening on :${config.apiPort}`);
  if (!config.cookieSecure) {
    console.warn(
      "[admin] ADMIN_INSECURE_COOKIE=true — the session cookie is being sent without " +
        "Secure. Local development only.",
    );
  }

  const shutdown = async () => {
    await app.close();
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
