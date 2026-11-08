import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "test/**/*.test.mjs"],
    setupFiles: ["test/setup.ts"],
    allowOnly: false,
    // Reuse workers and imported dependencies; setup.ts resets network guards per file.
    isolate: false,
  },
});
