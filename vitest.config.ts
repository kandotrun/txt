import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "tests/protocol/**/*.test.ts",
      "tests/editor/**/*.test.ts",
      "tests/sync/**/*.test.ts",
      "tests/security/**/*.test.ts",
    ],
    environment: "node",
    globals: true,
  },
});
