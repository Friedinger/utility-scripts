import jsEslintConfig from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier/flat";
import tseslint from "typescript-eslint";
import { ESLint } from "eslint";
import { defineConfig, globalIgnores } from "eslint/config";

export default defineConfig(
  ESLint.defaultConfig,
  jsEslintConfig.configs.recommended,
  eslintConfigPrettier,
  tseslint.configs.recommended,
  tseslint.configs.stylistic,
  {
    linterOptions: {
      reportUnusedDisableDirectives: "error",
      reportUnusedInlineConfigs: "error",
    },
    rules: {
      "no-console": ["error", { allow: ["debug"] }],
    },
  },
  globalIgnores(["dist", "node_modules"]),
);
