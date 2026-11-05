import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, describe, expect, it } from "vitest";
import {
  ProcessLock,
  ProcessLockTimeoutError,
} from "../../adapters/mcp/src/process-lock.js";
const scratch = { path: mkdtempSync(join(tmpdir(), "flockbot-lock-test-")) };
afterAll(() => rmSync(scratch.path, { recursive: true, force: true }));
describe("MCP coordination lock", () => {
  it("times out a waiter without taking the lock from a slow holder", async () => {
    const lock = new ProcessLock(join(scratch.path, "slow.sqlite"));
    let finish: () => void = () => undefined;
    const holder = lock.runExclusive(
      "browser",
      new AbortController().signal,
      () =>
        new Promise<string>((resolve) => {
          finish = () => resolve("held");
        }),
    );
    await delay(50);
    await expect(
      lock.runExclusive(
        "browser",
        AbortSignal.timeout(150),
        async () => "stolen",
      ),
    ).rejects.toBeInstanceOf(ProcessLockTimeoutError);
    finish();
    await expect(holder).resolves.toBe("held");
    await expect(
      lock.runExclusive(
        "browser",
        AbortSignal.timeout(1000),
        async () => "next",
      ),
    ).resolves.toBe("next");
  });

  it("keeps the lock until cancelled work settles", async () => {
    const lock = new ProcessLock(join(scratch.path, "cancel.sqlite"));
    const controller = new AbortController();
    const order: string[] = [];
    const holder = lock.runExclusive("browser", controller.signal, async () => {
      controller.abort();
      await delay(200);
      order.push("first settled");
    });
    await delay(50);
    await lock.runExclusive("browser", AbortSignal.timeout(2000), async () => {
      order.push("second ran");
    });
    await holder;
    expect(order).toEqual(["first settled", "second ran"]);
  });

  it("does not run work when the wait is already cancelled", async () => {
    const lock = new ProcessLock(join(scratch.path, "aborted.sqlite"));
    let ran = false;
    await expect(
      lock.runExclusive("browser", AbortSignal.abort(), async () => {
        ran = true;
      }),
    ).rejects.toBeInstanceOf(ProcessLockTimeoutError);
    expect(ran).toBe(false);
  });

  it("releases after a failed callback", async () => {
    const lock = new ProcessLock(join(scratch.path, "failed.sqlite"));
    await expect(
      lock.runExclusive("browser", new AbortController().signal, async () => {
        throw new Error("fictional failure");
      }),
    ).rejects.toThrow("fictional failure");
    await expect(
      lock.runExclusive("browser", AbortSignal.timeout(500), async () => "ok"),
    ).resolves.toBe("ok");
  });
});
