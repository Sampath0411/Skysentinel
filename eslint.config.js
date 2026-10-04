import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/coverage/**",
      "**/*.tsbuildinfo",
      "apps/client/dist/**",
      "apps/desktop/out/**",
      "data/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Build scripts run under Node, not a browser. `js.configs.recommended` turns on
    // `no-undef` and does not know that `process` and `console` exist there, so
    // without this the codegen scripts cannot be linted at all. Declared inline
    // rather than pulled from the `globals` package to avoid a new dependency.
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
        URL: "readonly",
      },
    },
  },
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": "error",
      "no-console": "off",
      eqeqeq: ["error", "always", { null: "ignore" }],
    },
  },
);