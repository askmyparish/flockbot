import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const test = spawnSync(
  process.execPath,
  ["node_modules/vitest/vitest.mjs", "run", "test/mcp/browser-runtime.test.ts"],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      FLOCKBOT_BROWSER_TESTS: "1",
      PLAYWRIGHT_BROWSERS_PATH:
        process.env.PLAYWRIGHT_BROWSERS_PATH ??
        resolve("adapters/mcp/.cache/browsers"),
    },
  },
);
process.exitCode = test.status ?? 1;
