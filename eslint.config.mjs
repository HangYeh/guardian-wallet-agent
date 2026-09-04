import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Hardhat 產生的型別與 artifacts 不是我們寫的，也不進版控的審查範圍
    "chain/artifacts/**",
    "chain/cache/**",
    "chain/types/**",
  ]),
]);

export default eslintConfig;
