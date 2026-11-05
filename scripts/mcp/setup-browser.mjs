import { spawn } from "node:child_process";
import { fstatSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const filename = fileURLToPath(import.meta.url);
const root = dirname(filename);
const mac = process.platform === "darwin";
let stdio = "ignore";
if (mac && process.env.FLOCKBOT_SETUP_LOCK_FD === "9") {
  try {
    if (!fstatSync(9).isFile()) throw new Error();
    stdio = ["ignore", "ignore", "ignore", ...Array(6).fill("ignore"), 9];
  } catch {
    console.error("Flockbot setup lost its lock descriptor. Rerun setup.");
    process.exit(1);
  }
}

const supervise = mac && process.argv[2] === "--supervise";
let cancelled = false;
let child;
const stop = () => {
  if (!child?.pid) return;
  try {
    // The supervisor owns a separate session from both its caller and the CLI.
    // Playwright's forked downloader inherits the CLI's process group, not fd 9.
    process.kill(supervise ? -child.pid : child.pid, "SIGKILL");
  } catch {}
};
const cancel = () => {
  cancelled = true;
  if (mac && !supervise) {
    // Do not exit/release the lock until the supervisor has stopped descendants.
    try {
      child?.kill("SIGTERM");
    } catch {}
  } else stop();
};
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
  process.on(signal, cancel);

// On macOS a detached, per-invocation supervisor owns the deadline and lock.
// Killing the calling shell AND helper cannot remove its timer. It never starts
// another setup, and exits after this one CLI group has been stopped. Loss of the
// caller's IPC channel deliberately leaves the deadline running.
if (supervise) process.on("disconnect", () => {});
const installed = await new Promise((resolve) => {
  const supervisingChild = mac && !supervise;
  child = spawn(
    process.execPath,
    supervisingChild
      ? [filename, "--supervise"]
      : [
          join(root, "node_modules/playwright/cli.js"),
          "install",
          "chromium",
          "--no-shell",
        ],
    {
      detached: mac,
      stdio: supervisingChild
        ? stdio === "ignore"
          ? ["ignore", "ignore", "ignore", "ipc"]
          : stdio.map((entry, index) => (index === 3 ? "ipc" : entry))
        : "ignore",
      env: {
        ...process.env,
        PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT: "30000",
      },
    },
  );
  // Only the supervisor (or the unchanged Windows direct-child boundary) owns
  // this timer. A cancelled invocation can never become a successful install.
  const timer = supervisingChild ? undefined : setTimeout(cancel, 300_000);
  if (cancelled) cancel();
  let finishing = false;
  const finish = async (code) => {
    if (finishing) return;
    finishing = true;
    if (supervise) {
      stop();
      // Retain fd 9 until ALL members have exited, including a downloader that
      // outlives its CLI and did not inherit the lock descriptor.
      while (child.pid) {
        try {
          process.kill(-child.pid, 0);
        } catch {
          break;
        }
        await new Promise((done) => setTimeout(done, 20));
      }
    }
    clearTimeout(timer);
    resolve(code === 0 && !cancelled ? 0 : 1);
  };
  child.once("error", () => finish(1));
  child.once("close", finish);
});
if (installed !== 0)
  console.error(
    "Flockbot browser preparation failed or timed out. Rerun setup.",
  );
// Explicit exit also closes the supervisor's inherited IPC and lock descriptors.
process.exit(installed);
