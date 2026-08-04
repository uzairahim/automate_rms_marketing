import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Load the repo-root `.env` into `process.env` for local dev, if present.
 *
 * `tsx watch` does not auto-load `.env`, so the documented
 * `cp .env.example .env && npm run dev:admin` flow needs this. Import it as the
 * FIRST import in every process entrypoint so variables are set before
 * {@link ./config.ts} reads them. In production, env comes from the orchestrator
 * and `.env` simply won't exist — the guard makes this a no-op.
 */
const here = dirname(fileURLToPath(import.meta.url));
// src/ (dev via tsx) or dist/ (built) → repo root is three levels up either way:
//   packages/admin/{src,dist} → packages/admin → packages → <root>
const envPath = resolve(here, "..", "..", "..", ".env");

if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}
