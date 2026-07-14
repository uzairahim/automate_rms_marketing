import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Load the repo-root `.env` into `process.env` for local dev, if present.
 *
 * `npm run dev` / `tsx watch` do not auto-load `.env`, so the documented
 * `cp .env.example .env && npm run dev` flow needs this. Import it as the FIRST
 * import in every process entrypoint (api, worker, migrate) so variables are set
 * before {@link ./config.ts} reads them. In production, env comes from the
 * orchestrator and `.env` simply won't exist — the guard makes this a no-op.
 */
const here = dirname(fileURLToPath(import.meta.url));
// src/ (dev via tsx) or dist/ (built) → repo root is three levels up either way:
//   packages/server/{src,dist} → packages/server → packages → <root>
const envPath = resolve(here, "..", "..", "..", ".env");

if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}
