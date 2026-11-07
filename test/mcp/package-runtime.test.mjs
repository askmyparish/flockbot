import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

async function fixture({ onTestFinished }) {
  // Match the package check: Windows TEMP can contain an 8.3 path alias,
  // while process metadata reports the executable's canonical path.
  const root = await mkdtemp(
    join(await realpath(tmpdir()), "flockbot-package-process-"),
  );
  const children = [];
  onTestFinished(async () => {
    for (const { child } of children) child.kill();
    await Promise.all(children.map(({ closed }) => closed));
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  });
  async function start(name, source) {
    const directory = join(root, name);
    await mkdir(directory);
    const node = join(directory, "node.exe");
    await copyFile(process.execPath, node);
    const child = spawn(node, ["-e", `console.log('ready'); ${source}`], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    const closed = once(child, "close");
    children.push({ child, closed });
    await Promise.race([
      once(child.stdout, "data"),
      closed.then(() => {
        throw new Error("The fixture exited before it was ready.");
      }),
    ]);
    return { child, node, closed };
  }
  function wait(node) {
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-File",
        resolve("scripts/mcp/wait-package-runtime.ps1"),
        "-RuntimeNode",
        node,
      ],
      { stdio: "pipe", timeout: 20_000 },
    );
  }
  return { start, wait };
}

describe.skipIf(process.platform !== "win32")(
  "Windows package process cleanup",
  () => {
    it("waits for the copied runtime to exit before deleting its executable", async (context) => {
      const f = await fixture(context);
      const runtime = await f.start(
        "runtime with spaces",
        "setTimeout(() => {}, 4000)",
      );
      f.wait(runtime.node);
      expect(() => process.kill(runtime.child.pid, 0)).toThrow();
      await runtime.closed;
      expect(runtime.child.exitCode).toBe(0);
      await rm(runtime.node, {
        recursive: true,
        maxRetries: 10,
        retryDelay: 100,
      });
    }, 30_000);

    it("reaps a surviving fixture, reports failure, and preserves another Node executable", async (context) => {
      const f = await fixture(context);
      const runtime = await f.start(
        "runtime with spaces",
        "setInterval(() => {}, 1000)",
      );
      const unrelated = await f.start(
        "unrelated runtime",
        "setInterval(() => {}, 1000)",
      );
      expect(() => process.kill(runtime.child.pid, 0)).not.toThrow();
      expect(() => f.wait(runtime.node)).toThrow(
        /runtime processes survived MCP shutdown/,
      );
      await runtime.closed;
      expect(unrelated.child.exitCode).toBeNull();
      expect(() => process.kill(unrelated.child.pid, 0)).not.toThrow();
      await rm(runtime.node, {
        recursive: true,
        maxRetries: 10,
        retryDelay: 100,
      });
    }, 30_000);
  },
);
