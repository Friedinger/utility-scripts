import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The sync tests build real Git repos, which is slow on Windows runners.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    coverage: {
      provider: "v8",
      include: ["src/**"],
    },
  },
});
