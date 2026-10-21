import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        extends: "./vite.config.ts",
        test: {
          name: "frontend",
          include: ["src/**/*.test.{ts,tsx}"],
          environment: "node",
        },
      },
      // Module unit tests run against an in-memory datastore (SpacetimeDB's
      // own, compiled to wasm). The module's own config carries the plugins
      // they need: SpacetimeDB's stand-in for the `spacetime:sys` host
      // imports, and a loader for the `.txt` wordlist.
      {
        extends: "./spacetimedb/vitest.config.ts",
        root: "spacetimedb",
        test: {
          name: "backend",
          include: ["src/tests/**/*.test.ts"],
          environment: "node",
        },
      },
    ],
    // There are no frontend tests yet.
    passWithNoTests: true,
  },
});
