import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./test-database-guard.mjs"],
    environment: "node",
    globals: false,
    testTimeout: 30000,
    include: ["src/**/*.test.ts"],
    singleFork: true,
  },
});
