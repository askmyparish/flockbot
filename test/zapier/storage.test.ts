import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { describe, expect, it, vi } from "vitest";
import {
  ProbeStorageClient,
  type StorageFetch,
} from "../../adapters/zapier/src/storage.js";
import {
  probeZapierStorage,
  STORAGE_PROBE_CONSENT,
} from "../../scripts/zapier/storage-probe.js";

// Fictional credential accepted only by the injected offline transport.
const secret = "12345678-1234-4234-8234-123456789abc";
const consent = { consent: STORAGE_PROBE_CONSENT, dedicatedStore: true };
const signal = () => new AbortController().signal;
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status });

/** Explicit model, NOT the SDK mock and NOT production Storage evidence. */
function model() {
  const values = new Map<string, string>();
  const requests: { url: string; options: RequestInit }[] = [];
  const transport = vi.fn<StorageFetch>(async (url, options) => {
    requests.push({ url, options });
    if (options.method === "PATCH") {
      const body = JSON.parse(String(options.body)) as {
        action: string;
        data: { key: string; value: string; previous_value: string | null };
      };
      expect(body.action).toBe("set_value_if");
      const { key, value, previous_value: previous } = body.data;
      if ((values.get(key) ?? null) !== previous)
        return json({ message: "Fictional conditional mismatch." }, 400);
      values.set(key, value);
      return json({ value });
    }
    const key = new URL(url).searchParams.get("key") as string;
    if (options.method === "DELETE") {
      values.delete(key);
      return json({});
    }
    return json(values.has(key) ? { [key]: values.get(key) } : {});
  });
  return { values, requests, transport };
}

describe("Storage REST candidate (offline)", () => {
  it("keeps the real wrapper inert without opt-in", () => {
    try {
      execFileSync(process.execPath, ["scripts/zapier/probe-storage.mjs"], {
        cwd: new URL("../..", import.meta.url),
        stdio: "pipe",
      });
      throw new Error("Expected inert wrapper exit.");
    } catch (error) {
      expect(error).toMatchObject({ status: 2 });
      expect(String((error as { stderr: unknown }).stderr)).toContain(
        "No requests made.",
      );
    }
  });

  it("uses header auth, exact origin, manual redirects and one key", async () => {
    const f = model();
    const client = new ProbeStorageClient(secret, f.transport);
    expect(await client.read("fictional-key", signal())).toBeNull();
    await client.setIf("fictional-key", null, "fictional-state", signal());
    expect(await client.read("fictional-key", signal())).toBe(
      "fictional-state",
    );
    await client.remove("fictional-key", signal());
    for (const { url, options } of f.requests) {
      expect(new URL(url).origin).toBe("https://store.zapier.com");
      expect(url).not.toContain(secret);
      expect(options).toMatchObject({
        redirect: "manual",
        credentials: "omit",
        headers: { "X-Secret": secret },
      });
      expect(options.signal).toBeInstanceOf(AbortSignal);
      if (options.method !== "PATCH")
        expect(new URL(url).searchParams.get("key")).toBe("fictional-key");
    }
  });

  it.each(["", "bad", "12345678-1234-1234-8234-123456789abc", "\n"])(
    "rejects invalid secret before transport",
    (value) => {
      const transport = vi.fn<StorageFetch>();
      expect(() => new ProbeStorageClient(value, transport)).toThrow(
        "invalid_configuration",
      );
      expect(transport).not.toHaveBeenCalled();
    },
  );

  it.each(["", "../all", "x?secret=bad", "x".repeat(32), "https://other.test"])(
    "rejects unsafe keys for every method",
    async (key) => {
      const transport = vi.fn<StorageFetch>();
      const client = new ProbeStorageClient(secret, transport);
      await expect(client.read(key, signal())).rejects.toMatchObject({
        code: "invalid_key",
      });
      await expect(
        client.setIf(key, null, "value", signal()),
      ).rejects.toMatchObject({ code: "invalid_key" });
      await expect(client.remove(key, signal())).rejects.toMatchObject({
        code: "invalid_key",
      });
      expect(transport).not.toHaveBeenCalled();
    },
  );

  it("bounds values conservatively in bytes before making a request", async () => {
    const transport = vi.fn<StorageFetch>();
    const client = new ProbeStorageClient(secret, transport);
    await expect(
      client.setIf("key", null, "ü".repeat(1250), signal()),
    ).rejects.toMatchObject({ code: "invalid_configuration" });
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([302, 400, 401, 403, 429, 503])(
    "never retries HTTP %s or returns its body",
    async (status) => {
      const transport = vi.fn<StorageFetch>(
        async () =>
          new Response(`PRIVATE-${secret}`, {
            status,
            headers: { Location: "https://other.test" },
          }),
      );
      const client = new ProbeStorageClient(secret, transport);
      await expect(client.read("key", signal())).rejects.toMatchObject({
        code: "storage_http_failed",
        status,
      });
      expect(transport).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    [],
    "PRIVATE",
    12,
    null,
    { key: {} },
    { message: "throttled" },
    { key: "value", message: "unexpected" },
  ])("rejects unrecognized read shapes", async (body) => {
    const client = new ProbeStorageClient(secret, async () => json(body));
    await expect(client.read("key", signal())).rejects.toMatchObject({
      code: "storage_protocol_error",
    });
  });

  it("sanitizes malformed JSON and raw transport exceptions", async () => {
    const badJson = new ProbeStorageClient(
      secret,
      async () => new Response(`PRIVATE-${secret}`),
    );
    await expect(badJson.read("key", signal())).rejects.toMatchObject({
      code: "storage_protocol_error",
    });
    const transport = vi.fn<StorageFetch>(async () => {
      throw new Error(`PRIVATE-${secret}`);
    });
    const client = new ProbeStorageClient(secret, transport);
    try {
      await client.setIf("key", null, "value", signal());
      throw new Error("Expected failure.");
    } catch (error) {
      expect(error).toMatchObject({ code: "storage_transport_failed" });
      expect(inspect(error)).not.toContain(secret);
      expect(inspect(error)).not.toContain("PRIVATE");
    }
    expect(transport).toHaveBeenCalledTimes(1);
    expect(inspect(client, { showHidden: true })).not.toContain(secret);
    expect(JSON.stringify(client)).not.toContain(secret);
  });

  it("does not send pre-cancelled work", async () => {
    const transport = vi.fn<StorageFetch>();
    const client = new ProbeStorageClient(secret, transport);
    const controller = new AbortController();
    controller.abort();
    await expect(client.read("key", controller.signal)).rejects.toMatchObject({
      code: "storage_cancelled",
    });
    expect(transport).not.toHaveBeenCalled();
  });

  it("bounds an ignoring transport and never sends again", async () => {
    vi.useFakeTimers();
    try {
      const transport = vi.fn<StorageFetch>(() => new Promise(() => {}));
      const client = new ProbeStorageClient(secret, transport);
      const result = expect(
        client.setIf("key", null, "value", signal()),
      ).rejects.toMatchObject({ code: "storage_timeout" });
      await vi.advanceTimersByTimeAsync(2000);
      await result;
      expect(transport).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds response-body reading and cancels in-flight work", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const transport = vi.fn<StorageFetch>(
        async () =>
          ({ ok: true, json: () => new Promise(() => {}) }) as Response,
      );
      const client = new ProbeStorageClient(secret, transport);
      const result = expect(
        client.read("key", controller.signal),
      ).rejects.toMatchObject({ code: "storage_cancelled" });
      await Promise.resolve();
      controller.abort();
      await result;
      expect(transport).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("enforces the fixed request cap", async () => {
    const transport = vi.fn<StorageFetch>(async () => json({}));
    const client = new ProbeStorageClient(secret, transport);
    for (let i = 0; i < 14; i++) await client.read("key", signal());
    await expect(client.read("key", signal())).rejects.toMatchObject({
      code: "request_budget_exceeded",
    });
    expect(transport).toHaveBeenCalledTimes(14);
  });

  it("models conditional creation, one contender, stale rejection, reload and keyed cleanup", async () => {
    const f = model();
    const result = await probeZapierStorage(
      consent,
      new ProbeStorageClient(secret, f.transport),
    );
    expect(result).toMatchObject({
      passed: true,
      checks: {
        initialized: true,
        nullOverwriteRejected: true,
        singleWinner: true,
        staleUpdateRejected: true,
        reloaded: true,
      },
      cleanup: "confirmed",
      requests: 12,
      atomicityProven: false,
      unresolvedWrites: 0,
    });
    expect(result.observations).toEqual({
      initialRead: { status: 200 },
      initialize: { status: 200 },
      nullOverwrite: { status: 400, failure: "storage_http_failed" },
      initializedRead: { status: 200 },
      contenderA: { status: 200 },
      contenderB: { status: 400, failure: "storage_http_failed" },
      winnerRead: { status: 200 },
      staleUpdate: { status: 400, failure: "storage_http_failed" },
      reload: { status: 200 },
      cleanupRead: { status: 200 },
      cleanupDelete: { status: 200 },
      cleanupVerify: { status: 200 },
    });
    expect(f.values.size).toBe(0);
    const keys = new Set(
      f.requests.map(({ url, options }) =>
        options.method === "PATCH"
          ? JSON.parse(String(options.body)).data.key
          : new URL(url).searchParams.get("key"),
      ),
    );
    expect(keys.size).toBe(1);
    expect([...keys][0]).toMatch(/^fbprobe_[a-f0-9]{22}$/);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it.each([
    { consent: "", dedicatedStore: true },
    { consent: STORAGE_PROBE_CONSENT, dedicatedStore: false },
  ])("keeps invalid probe requests inert", async (config) => {
    const f = model();
    await expect(
      probeZapierStorage(config, new ProbeStorageClient(secret, f.transport)),
    ).rejects.toMatchObject({ code: "invalid_configuration" });
    expect(f.requests).toHaveLength(0);
  });

  it("never modifies or cleans up a collided key", async () => {
    const transport = vi.fn<StorageFetch>(async (url) =>
      json({ [new URL(url).searchParams.get("key") as string]: "preexisting" }),
    );
    const result = await probeZapierStorage(
      consent,
      new ProbeStorageClient(secret, transport),
    );
    expect(result).toMatchObject({
      passed: false,
      cleanup: "not_needed",
      requests: 1,
    });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("reconciles only cleanup after a lost creation acknowledgement, with no write replay", async () => {
    const f = model();
    let lost = false;
    const transport = vi.fn<StorageFetch>(async (url, options) => {
      const response = await f.transport(url, options);
      if (options.method === "PATCH" && !lost) {
        lost = true;
        throw new Error(`PRIVATE-${secret}`);
      }
      return response;
    });
    const result = await probeZapierStorage(
      consent,
      new ProbeStorageClient(secret, transport),
    );
    expect(result).toMatchObject({
      passed: false,
      failure: "storage_transport_failed",
      cleanup: "confirmed",
    });
    expect(f.requests.filter((r) => r.options.method === "PATCH")).toHaveLength(
      1,
    );
    expect(f.values.size).toBe(0);
  });

  it("reports uncertainty when an unacknowledged write cannot be found", async () => {
    let patches = 0;
    let deletes = 0;
    const transport: StorageFetch = async (_url, options) => {
      if (options.method === "PATCH") {
        patches++;
        throw new Error("Lost request.");
      }
      if (options.method === "DELETE") deletes++;
      return json({});
    };
    const result = await probeZapierStorage(
      consent,
      new ProbeStorageClient(secret, transport),
    );
    expect(result).toMatchObject({ passed: false, cleanup: "unconfirmed" });
    expect(patches).toBe(1);
    expect(deletes).toBe(0);
  });

  it("does not call a plausible final value proof if both contenders report success", async () => {
    const f = model();
    const transport: StorageFetch = async (url, options) => {
      const response = await f.transport(url, options);
      const body =
        options.method === "PATCH" ? JSON.parse(String(options.body)) : null;
      return response.status === 400 && body?.data.previous_value !== null
        ? json({ success: false })
        : response;
    };
    const result = await probeZapierStorage(
      consent,
      new ProbeStorageClient(secret, transport),
    );
    expect(result).toMatchObject({
      passed: false,
      failure: "probe_check_failed",
      checks: { singleWinner: false },
      cleanup: "unconfirmed",
      unresolvedWrites: 1,
    });
  });

  it("reports cleanup failure separately and never repeats DELETE", async () => {
    const f = model();
    const transport = vi.fn<StorageFetch>(async (url, options) =>
      options.method === "DELETE"
        ? json({ private: secret }, 503)
        : f.transport(url, options),
    );
    const result = await probeZapierStorage(
      consent,
      new ProbeStorageClient(secret, transport),
    );
    expect(result).toMatchObject({ passed: false, cleanup: "unconfirmed" });
    expect(
      transport.mock.calls.filter(([, options]) => options.method === "DELETE"),
    ).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("rejects a service that treats null previous value as an unconditional overwrite", async () => {
    const f = model();
    const transport: StorageFetch = async (url, options) => {
      if (options.method === "PATCH") {
        const {
          key,
          value,
          previous_value: previous,
        } = JSON.parse(String(options.body)).data;
        if (previous === null) {
          f.values.set(key, value);
          return json({});
        }
      }
      return f.transport(url, options);
    };
    const result = await probeZapierStorage(
      consent,
      new ProbeStorageClient(secret, transport),
    );
    expect(result).toMatchObject({
      passed: false,
      checks: { nullOverwriteRejected: false },
      observations: { nullOverwrite: { status: 200 } },
    });
  });

  it("does not mutate or clean up after a failed initial read", async () => {
    const transport = vi.fn<StorageFetch>(async () =>
      json({ private: secret }, 503),
    );
    const result = await probeZapierStorage(
      consent,
      new ProbeStorageClient(secret, transport),
    );
    expect(result).toMatchObject({
      passed: false,
      requests: 1,
      cleanup: "not_needed",
      observations: { initialRead: { status: 503 } },
    });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("does not call an unrelated 2xx object confirmed absence", async () => {
    const f = model();
    let deleted = false;
    const transport: StorageFetch = async (url, options) => {
      if (deleted && options.method === "GET")
        return json({ message: "throttled" });
      const response = await f.transport(url, options);
      if (options.method === "DELETE") deleted = true;
      return response;
    };
    const result = await probeZapierStorage(
      consent,
      new ProbeStorageClient(secret, transport),
    );
    expect(result).toMatchObject({
      passed: false,
      cleanup: "unconfirmed",
      observations: {
        cleanupVerify: { status: 200, failure: "storage_protocol_error" },
      },
    });
  });

  it.each(["winner mismatch", "stale accepted", "reload mismatch"])(
    "detects %s independently",
    async (fault) => {
      const f = model();
      let patches = 0;
      let reads = 0;
      const transport: StorageFetch = async (url, options) => {
        if (options.method === "PATCH") {
          patches++;
          if (fault === "stale accepted" && patches === 5) {
            const { key, value } = JSON.parse(String(options.body)).data;
            f.values.set(key, value);
            return json({});
          }
        }
        if (options.method === "GET") {
          reads++;
          if (
            (fault === "winner mismatch" && reads === 3) ||
            (fault === "reload mismatch" && reads === 4)
          )
            return json({
              [new URL(url).searchParams.get("key") as string]:
                "foreign-marker",
            });
        }
        return f.transport(url, options);
      };
      const result = await probeZapierStorage(
        consent,
        new ProbeStorageClient(secret, transport),
      );
      expect(result.passed).toBe(false);
      expect(result.failure).toBe("probe_check_failed");
      if (fault === "winner mismatch")
        expect(result.checks.singleWinner).toBe(false);
      if (fault === "stale accepted")
        expect(result.checks).toMatchObject({
          singleWinner: true,
          staleUpdateRejected: false,
        });
      if (fault === "reload mismatch")
        expect(result.checks).toMatchObject({
          singleWinner: true,
          staleUpdateRejected: true,
          reloaded: false,
        });
    },
  );

  it.each([3, 5])(
    "does not confirm cleanup with an unobserved late PATCH at position %s",
    async (lostPatch) => {
      const f = model();
      let patches = 0;
      let late: (() => void) | undefined;
      const transport: StorageFetch = async (url, options) => {
        if (options.method === "PATCH" && ++patches === lostPatch) {
          const { key, value } = JSON.parse(String(options.body)).data;
          // Deliberately broken server: commit unconditionally after cleanup.
          late = () => {
            f.values.set(key, value);
          };
          throw new Error("Lost acknowledgement.");
        }
        return f.transport(url, options);
      };
      const result = await probeZapierStorage(
        consent,
        new ProbeStorageClient(secret, transport),
      );
      expect(result).toMatchObject({
        passed: false,
        cleanup: "unconfirmed",
        unresolvedWrites: 1,
      });
      expect(f.values.size).toBe(0);
      late?.();
      expect(f.values.size).toBe(1);
      expect(patches).toBe(lostPatch === 3 ? 4 : 5);
    },
  );

  it.each([2, 3, 5])(
    "keeps an acknowledged but unobserved PATCH unresolved at position %s",
    async (delayedPatch) => {
      const f = model();
      let patches = 0;
      let late: (() => void) | undefined;
      const transport: StorageFetch = async (url, options) => {
        if (options.method === "PATCH" && ++patches === delayedPatch) {
          const { key, value } = JSON.parse(String(options.body)).data;
          late = () => {
            f.values.set(key, value);
          };
          return json({});
        }
        return f.transport(url, options);
      };
      const result = await probeZapierStorage(
        consent,
        new ProbeStorageClient(secret, transport),
      );
      expect(result).toMatchObject({
        passed: false,
        cleanup: "unconfirmed",
        unresolvedWrites: 1,
        atomicityProven: false,
      });
      expect(f.values.size).toBe(0);
      late?.();
      expect(f.values.size).toBe(1);
    },
  );

  it.each([408, 409, 429, 503])(
    "keeps a PATCH status %s unresolved without leaking a response body",
    async (status) => {
      const f = model();
      const transport: StorageFetch = async (url, options) => {
        const response = await f.transport(url, options);
        return response.status === 400
          ? json({ private: secret }, status)
          : response;
      };
      const result = await probeZapierStorage(
        consent,
        new ProbeStorageClient(secret, transport),
      );
      expect(result).toMatchObject({
        passed: false,
        cleanup: "unconfirmed",
        unresolvedWrites: 1,
        observations: {
          nullOverwrite: { status, failure: "storage_http_failed" },
        },
      });
      expect(JSON.stringify(result)).not.toContain(secret);
    },
  );

  // Argument/file guards run before dispatch: repeating them for every mode
  // adds subprocesses, not coverage. UUID validation has three distinct consumers.
  it.each([
    ...["partial", "reordered", "readable", "symlink", "oversize"].map(
      (fault) => ({ fault, flag: "--authorize-isolated-storage-probe" }),
    ),
    ...[
      "--authorize-isolated-storage-probe",
      "--authorize-isolated-storage-diagnostic",
      "--authorize-storage-comparison-diagnostic",
    ].map((flag) => ({ fault: "invalid UUID", flag })),
  ])("keeps the wrapper offline for $fault with $flag", ({ fault, flag }) => {
    const directory = mkdtempSync(join(tmpdir(), "flockbot-probe-test-"));
    try {
      const path = join(directory, "fictional-secret");
      const preload = join(directory, "block-network.mjs");
      // The child does not inherit Vitest's network guards. This independent
      // tripwire makes a security-gate regression fail instead of going online.
      writeFileSync(
        preload,
        'globalThis.fetch = () => { process.stderr.write("UNEXPECTED_NETWORK"); process.exit(90); };',
      );
      writeFileSync(
        path,
        fault === "oversize"
          ? secret.padEnd(129, " ")
          : fault === "invalid UUID"
            ? "not-a-uuid"
            : secret,
        { mode: 0o600 },
      );
      if (fault === "readable") chmodSync(path, 0o640);
      let supplied = path;
      if (fault === "symlink") {
        supplied = join(directory, "link");
        symlinkSync(path, supplied);
      }
      let args = [flag, "--dedicated-store", "--secret-file", supplied];
      if (fault === "partial") args = [flag];
      if (fault === "reordered")
        args = ["--dedicated-store", flag, "--secret-file", supplied];
      try {
        execFileSync(
          process.execPath,
          ["--import", preload, "scripts/zapier/probe-storage.mjs", ...args],
          { cwd: new URL("../..", import.meta.url), stdio: "pipe" },
        );
        throw new Error("Expected a stopped wrapper.");
      } catch (error) {
        expect(error).toMatchObject({
          status: fault === "partial" || fault === "reordered" ? 2 : 1,
        });
        const stderr = String((error as { stderr: unknown }).stderr);
        expect(stderr).not.toContain("UNEXPECTED_NETWORK");
        expect(stderr).not.toContain(secret);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
