import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * A config of its own, rather than reusing vite.config.ts.
 *
 * The app's vite config requires PORT and builds the whole dev server; the
 * tests here are pure functions and need neither. Pointing vitest at the app
 * config makes `pnpm test` fail with "PORT environment variable is required",
 * which is a confusing way to be told nothing is wrong.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    environment: "node",
  },
});
