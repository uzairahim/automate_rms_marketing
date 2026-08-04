import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // Run the suite against `@smma/core`'s sources rather than its build
      // output. The package resolves to `dist/` everywhere else (build,
      // typecheck, the dev stack), but a test run must never be able to pass
      // against a stale compile of a package edited in the same commit.
      "@smma/core": fileURLToPath(new URL("../core/src/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    // Testcontainers can take a while to pull/boot images on a cold machine.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // Each test file gets its own ephemeral containers; keep them isolated.
    fileParallelism: false,
  },
});
