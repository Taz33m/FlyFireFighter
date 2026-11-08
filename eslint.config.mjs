import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  { rules: { complexity: ["error", 15] } },
  // src/lib runs under Node's type stripping in tests: type-only imports must be marked.
  { files: ["src/lib/**/*.ts"], rules: { "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "separate-type-imports" }] } },
  globalIgnores([".next/**", "out/**", "build/**", "coverage/**", "next-env.d.ts", "**/.venv/**", "services/**", "models/cache/**", "assets/cache/**"]),
]);
