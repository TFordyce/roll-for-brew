import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    setupFiles: ["./vitest.setup.ts"],
    // The integration suite shares one real-world "today" room across
    // files (rooms are keyed by calendar date, and the schema enforces one
    // active round per room), so concurrent test files racing to
    // start/close rounds in it collide. Run files sequentially.
    fileParallelism: false,
  },
});
