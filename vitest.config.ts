import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    conditions: ["ave-source", "import", "default"],
  },
  test: {
    include: [
      "packages/**/*.test.ts",
      "storage/**/*.test.ts",
      "services/**/*.test.ts",
      "apps/**/*.test.ts",
    ],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "downstream/**",
      "vendor/**",
      "paseo/**",
      "pi/**",
      "filmcraft/**",
      "references/**",
    ],
  },
});
