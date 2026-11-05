import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const installed = spawnSync(
  process.execPath,
  [
    join(root, "node_modules/playwright/cli.js"),
    "install",
    "chromium",
    "--no-shell",
  ],
  { stdio: "inherit" },
);
process.exitCode = installed.status ?? 1;
