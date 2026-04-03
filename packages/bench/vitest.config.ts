import path from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    benchmark: {
      include: ["src/benches/**/*.bench.ts"],
    },
  },
  resolve: {
    alias: {
      "@next_term/core": path.resolve(
        __dirname,
        "../core/src/index.ts",
      ),
    },
  },
});
