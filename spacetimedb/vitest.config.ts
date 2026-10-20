import { readFileSync } from "node:fs";
import { spacetimedbModuleTestPlugin } from "spacetimedb/server/test-utils/vitest";
import { defineConfig, type Plugin } from "vitest/config";

// The module bundler imports `.txt` files (the wordlist) as strings; do the
// same under Vitest.
const textFiles: Plugin = {
  name: "text-files",
  enforce: "pre",
  load(id) {
    if (id.endsWith(".txt")) {
      return `export default ${JSON.stringify(readFileSync(id, "utf8"))};`;
    }
  },
};

export default defineConfig({
  plugins: [spacetimedbModuleTestPlugin() as unknown as Plugin, textFiles],
  test: {
    environment: "node",
  },
});
