import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Testcontainers can take a while to pull/boot images on a cold machine.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // Each test file gets its own ephemeral containers; keep them isolated.
    fileParallelism: false,
  },
});
