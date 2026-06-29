import js from "@eslint/js";
import tseslint from "typescript-eslint";
import astro from "eslint-plugin-astro";
import jsxA11y from "eslint-plugin-jsx-a11y";

export default tseslint.config(
  { ignores: ["dist/", "**/.astro/", "node_modules/", "*.tsbuildinfo", "coverage/"] },

  js.configs.recommended,

  jsxA11y.flatConfigs.recommended,

  ...tseslint.configs.strictTypeChecked,

  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  {
    files: ["**/*.astro", "**/*.mjs", "**/*.js"],
    ...tseslint.configs.disableTypeChecked,
  },

  ...astro.configs.recommended,

  {
    files: ["**/*.astro"],
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { varsIgnorePattern: "^(Astro|Props)$" }],
    },
  },
);
