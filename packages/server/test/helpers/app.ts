import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp, type AppDeps } from "../../src/app.js";
import { TestClock } from "../../src/core/clock.js";
import { FakePublisher } from "../../src/core/fake-publisher.js";
import { FakeEmailSender } from "../../src/core/fake-email.js";
import { createSecretCipher } from "../../src/core/crypto.js";

/**
 * Build the real app with test seams wired in, filling defaults for everything a
 * test doesn't care about.
 *
 * The app is always the real one — only its injected dependencies change (a pool
 * on an ephemeral Postgres, a {@link TestClock}, the {@link FakePublisher}).
 * Defaults live here so that adding a dependency to {@link AppDeps} doesn't mean
 * editing every suite that never mentions it.
 */

/** The key the test cipher uses. Fixed, so a test can decrypt what it stored. */
export const TEST_ENCRYPTION_KEY = Buffer.alloc(32, 7);

export const TEST_BASE_DOMAIN = "ourapp.test";
export const TEST_META_APP_SECRET = "test-meta-app-secret";
export const TEST_OAUTH_REDIRECT_BASE_URL = "https://connect.ourapp.test";
export const TEST_MEDIA_BASE_URL = "https://media.ourapp.test";

/** Build the app, overriding only the dependencies a suite actually exercises. */
export function buildTestApp(overrides: Partial<AppDeps> & Pick<AppDeps, "pool">): FastifyInstance {
  return buildApp({
    clock: new TestClock(),
    publisher: new FakePublisher(),
    emailSender: new FakeEmailSender(),
    tokenCipher: createSecretCipher(TEST_ENCRYPTION_KEY),
    baseDomain: TEST_BASE_DOMAIN,
    oauthRedirectBaseUrl: TEST_OAUTH_REDIRECT_BASE_URL,
    metaAppSecret: TEST_META_APP_SECRET,
    // A fresh throwaway directory per app build — Media is real disk I/O in
    // tests (like the ephemeral Postgres/Redis), not faked.
    mediaDir: mkdtempSync(path.join(tmpdir(), "smma-media-")),
    mediaBaseUrl: TEST_MEDIA_BASE_URL,
    ...overrides,
  });
}
