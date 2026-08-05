import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import type { Clock } from "../../src/clock.js";
// A **development-only** dependency on the Client-facing service (PRD #15). Some
// things the panel does are only provable on the other side of the platform: that
// a Client provisioned here is reachable at its subdomain, and that neither
// identity works on the other's surface. Nothing under `src/` imports this, so
// the admin service stays independently deployable.
import { buildApp } from "../../../server/src/app.js";
import { FakePublisher } from "../../../server/src/core/fake-publisher.js";
import { FakeEmailSender } from "../../../server/src/core/fake-email.js";
import { createSecretCipher } from "../../../server/src/core/crypto.js";

/** The base domain the Client-facing fixture resolves subdomains against. */
export const BASE_DOMAIN = "ourapp.test";

/** The Host header a given Client's subdomain arrives on. */
export function clientHost(subdomain: string): string {
  return `${subdomain}.${BASE_DOMAIN}`;
}

/**
 * Build the real Client-facing app against the same database, so a suite can
 * check what the panel's writes look like from the surface a Client actually
 * uses. Its platform-touching dependencies are fakes, because nothing here
 * should ever reach a platform API.
 */
export function buildTestClientApp(deps: { pool: pg.Pool; clock: Clock }): FastifyInstance {
  return buildApp({
    pool: deps.pool,
    clock: deps.clock,
    publisher: new FakePublisher(),
    emailSender: new FakeEmailSender(),
    tokenCipher: createSecretCipher(Buffer.alloc(32, 7)),
    baseDomain: BASE_DOMAIN,
    superadminToken: "unused-shared-token",
    oauthRedirectBaseUrl: "https://connect.ourapp.test",
    mediaDir: mkdtempSync(path.join(tmpdir(), "smma-admin-media-")),
    mediaBaseUrl: "https://media.ourapp.test",
  });
}
