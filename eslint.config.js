import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import { defineConfig } from "eslint/config";

export default defineConfig(
  {
    ignores: ["**/dist/**", "**/node_modules/**", "**/module_bindings/**"],
  },
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: { globals: globals.browser },
    extends: [reactHooks.configs.flat.recommended],
  },
  {
    files: ["spacetimedb/**/*.ts", "bot-starter/**/*.ts"],
    languageOptions: { globals: globals.node },
  },
  {
    files: ["**/*.js", "*.config.ts"],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
