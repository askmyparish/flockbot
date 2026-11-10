import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FailureLog } from "../../adapters/mcp/src/failure-log.js";
import {
  failureDiagnostic,
  runDiagnostic,
  safeLogRecord,
  verboseDiagnostic,
  recordResponse,
  type FailureDiagnostic,
  type VerboseDiagnostic,
} from "../../adapters/mcp/src/diagnostics.js";
import { FlockbotError } from "../../src/errors.js";
import { ProcessLock } from "../../adapters/mcp/src/process-lock.js";
import { run } from "./support.js";

const scratch: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  for (const directory of scratch.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});
function fixture() {
  const directory = fs.mkdtempSync(
    join(fs.realpathSync(tmpdir()), "flockbot-failure-log-"),
  );
  scratch.push(directory);
  const path = join(directory, "diagnostics-v1");
  const log = new FailureLog({ directory: path });
  return {
    directory,
    path,
    log,
    current: join(path, "failures.jsonl"),
    rotated: join(path, "failures.1.jsonl"),
  };
}
function record() {
  return runDiagnostic("subscriber_count", () =>
    failureDiagnostic(
      new FlockbotError(
        "invalid_response",
        200,
        undefined,
        undefined,
        "subscriber_count_invalid",
      ),
    ),
  );
}
function verboseRecord() {
  return runDiagnostic(
    "subscriber_count",
    () => {
      recordResponse(
        "group/101/getSubscriberCount",
        "GET",
        {
          contentType: "json",
          data: {
            subscriberCount: "1,234",
            email: "alex@example.test",
            token: "EXCLUDE_ME_73",
          },
        },
        1,
      );
      const value = verboseDiagnostic("success");
      if (!value) throw new Error("Missing capture");
      return value;
    },
    undefined,
    false,
    true,
  );
}
function line(value: FailureDiagnostic | VerboseDiagnostic = record()) {
  return JSON.stringify({ ...value, traceSaved: true }) + "\n";
}
function records(text: string | undefined) {
  if (text === undefined) throw new Error("Storage unavailable");
  return text.trim()
    ? text
        .trim()
        .split("\n")
        .map((row) => safeLogRecord(JSON.parse(row)))
    : [];
}

describe("bounded private failure log", () => {
  it("revalidates verbose bodies before writing and when reading existing records", async () => {
    const f = fixture();
    const value = verboseRecord();
    if (!value.exchanges[0]) throw new Error("Missing exchange");
    value.exchanges[0].response = {
      state: "captured",
      json: JSON.stringify({
        email: "alex@example.test",
        PHPSESSID: "EXCLUDE_ME_73",
        nested: [["Cookie", "EXCLUDE_ME_73"]],
      }),
    };
    expect(await f.log.save(value)).toBe(true);
    expect(fs.readFileSync(f.current, "utf8")).not.toContain("EXCLUDE_ME_73");
    fs.writeFileSync(f.current, line(value));
    const filtered = await f.log.read();
    expect(filtered).not.toContain("EXCLUDE_ME_73");
    expect(filtered).toContain("alex@example.test");
    expect(fs.readFileSync(f.current, "utf8")).toBe(filtered);
    for (const attributes of [
      { "data-date": "0", id: "session" },
      { "data-date": "0", href: "EXCLUDE_ME_73" },
    ]) {
      value.exchanges[0].response = {
        state: "captured",
        format: "html",
        json: JSON.stringify({
          elements: [
            {
              position: 1,
              depth: 1,
              tag: "div",
              attributes,
              text: "EXCLUDE_ME_73",
            },
          ],
        }),
      };
      expect(await f.log.save(value)).toBe(true);
      expect(fs.readFileSync(f.current, "utf8")).not.toContain("EXCLUDE_ME_73");
      fs.writeFileSync(f.current, line(value));
      const html = await f.log.read();
      expect(html).not.toContain("EXCLUDE_ME_73");
      expect(fs.readFileSync(f.current, "utf8")).toBe(html);
      expect(records(html)[0]).toMatchObject({
        exchanges: [
          {
            response:
              "href" in attributes
                ? { state: "omitted", reason: "unsupported" }
                : {
                    state: "captured",
                    format: "html",
                    json: expect.stringContaining('"data-date":"0"'),
                  },
          },
        ],
      });
    }
  });

  it("persists only allowlisted bytes, with matching identity and private permissions", async () => {
    const f = fixture();
    const value = record();
    expect(
      await f.log.save({
        ...value,
        headers: "PRIVATE",
        password: "PRIVATE",
        failure: { ...value.failure, body: "PRIVATE" },
      } as typeof value),
    ).toBe(true);
    const text = fs.readFileSync(f.current, "utf8");
    expect(text).not.toContain("PRIVATE");
    expect(records(text)).toEqual([{ ...value, traceSaved: true }]);
    expect(
      await f.log.save({
        ...value,
        failure: { ...value.failure, reason: "PRIVATE" },
      }),
    ).toBe(false);
    expect(fs.readFileSync(f.current, "utf8")).toBe(text);
    expect(fs.statSync(f.path).mode & 0o777).toBe(0o700);
    expect(fs.statSync(f.current).mode & 0o777).toBe(0o600);
  });

  it.each([false, true])(
    "rotates only above 1 MiB and keeps at most two bounded files (verbose %s)",
    async (verbose) => {
      const f = fixture();
      const value = verbose ? verboseRecord() : record();
      const row = line(value);
      await f.log.read();
      const count = Math.floor((1024 * 1024) / Buffer.byteLength(row));
      fs.writeFileSync(f.current, row.repeat(count - 1));
      expect(await f.log.save(value)).toBe(true);
      expect(fs.statSync(f.current).size).toBe(Buffer.byteLength(row) * count);
      expect(fs.statSync(f.rotated).size).toBe(0);
      expect(await f.log.save(value)).toBe(true);
      expect(fs.statSync(f.current).size).toBe(Buffer.byteLength(row));
      expect(fs.statSync(f.rotated).size).toBe(Buffer.byteLength(row) * count);
      fs.writeFileSync(f.current, row.repeat(count));
      expect(await f.log.save({ ...value, operationId: randomUUID() })).toBe(
        true,
      );
      expect(
        fs.statSync(f.current).size + fs.statSync(f.rotated).size,
      ).toBeLessThanOrEqual(2 * 1024 * 1024);
      expect(
        fs.readdirSync(f.path).filter((name) => name.endsWith("jsonl")),
      ).toEqual(["failures.1.jsonl", "failures.jsonl"]);
    },
  );

  it.each([false, true])(
    "prunes both sides of seven days on access and write, including corrupt and partial rows (verbose %s)",
    async (verbose) => {
      const f = fixture();
      const make = verbose ? verboseRecord : record;
      const now = Date.now();
      const log = new FailureLog({ directory: f.path, now: () => now });
      await log.read();
      const edge = {
        ...make(),
        observedAt: new Date(now - 7 * 86_400_000).toISOString(),
      };
      const expired = {
        ...make(),
        observedAt: new Date(now - 7 * 86_400_000 - 1).toISOString(),
      };
      const recent = { ...make(), observedAt: new Date(now).toISOString() };
      fs.writeFileSync(
        f.current,
        line(edge) + line(expired) + "PRIVATE corrupt\n" + line(recent).trim(),
      );
      fs.writeFileSync(f.rotated, line(expired) + line(recent));
      expect(records(await log.read()).map((r) => r?.operationId)).toEqual([
        recent.operationId,
        edge.operationId,
      ]);
      fs.writeFileSync(f.rotated, line(expired));
      expect(await log.save(recent)).toBe(true);
      expect(fs.readFileSync(f.rotated, "utf8")).toBe("");
      fs.writeFileSync(f.current, "PRIVATE".repeat(160_000));
      expect(await log.save(recent)).toBe(true);
      expect(fs.readFileSync(f.current, "utf8")).toBe(line(recent));
    },
  );

  it("bounds canonical records even when compact numeric input grows on serialization", async () => {
    const f = fixture();
    await f.log.read();
    const value = record();
    value.failure.elapsedMs = 1_000_000_000_000;
    value.final.elapsedMs = 1_000_000_000_000;
    const compact = line(value).replaceAll("1000000000000", "1e12");
    fs.writeFileSync(
      f.current,
      compact.repeat(Math.floor((1024 * 1024) / Buffer.byteLength(compact))),
    );
    const retained = await f.log.read();
    expect(records(retained).length).toBeGreaterThan(0);
    expect(fs.statSync(f.current).size).toBeLessThanOrEqual(1024 * 1024);
  });

  it.skipIf(process.platform === "win32")(
    "preserves results when directory writes are denied",
    async () => {
      const f = fixture();
      fs.mkdirSync(f.path, { mode: 0o500 });
      try {
        expect(await f.log.save(record())).toBe(false);
      } finally {
        fs.chmodSync(f.path, 0o700);
      }
    },
  );

  it.each(["symlink", "hardlink", "directory", "permissions", "parent-link"])(
    "refuses unsafe %s targets without touching them",
    async (kind) => {
      const f = fixture();
      const target = join(f.directory, "private-target");
      fs.writeFileSync(target, "PRIVATE", { mode: 0o600 });
      if (kind === "parent-link") fs.symlinkSync(f.directory, f.path);
      else {
        fs.mkdirSync(f.path, { mode: 0o700 });
        if (kind === "symlink") fs.symlinkSync(target, f.current);
        if (kind === "hardlink") fs.linkSync(target, f.current);
        if (kind === "directory") fs.mkdirSync(f.current);
        if (kind === "permissions") fs.chmodSync(f.path, 0o755);
      }
      expect(await f.log.save(record())).toBe(false);
      expect(await f.log.read()).toBeUndefined();
      expect(fs.readFileSync(target, "utf8")).toBe("PRIVATE");
    },
  );

  it("fails closed on lock contention and disk errors, then recovers", async () => {
    const f = fixture();
    await f.log.read();
    await new ProcessLock(join(f.path, "writer.sqlite")).runExclusive(
      "test",
      new AbortController().signal,
      async () => {
        expect(await f.log.save(record())).toBe(false);
      },
    );
    const write = vi.spyOn(fs, "writeSync").mockImplementation(() => {
      throw new Error("PRIVATE disk error");
    });
    syncBuiltinESMExports();
    expect(await f.log.save(record())).toBe(false);
    write.mockRestore();
    syncBuiltinESMExports();
    expect(await f.log.save(record())).toBe(true);
    expect(records(await f.log.read())).toHaveLength(1);
  });

  it("keeps saved history intact when a later append fails", async () => {
    const f = fixture();
    const first = record();
    expect(await f.log.save(first)).toBe(true);
    const before = fs.readFileSync(f.current, "utf8");
    const write = vi.spyOn(fs, "writeSync").mockImplementation(() => {
      throw new Error("Fictional disk failure");
    });
    syncBuiltinESMExports();
    expect(await f.log.save(record())).toBe(false);
    expect(fs.readFileSync(f.current, "utf8")).toBe(before);
    write.mockRestore();
    syncBuiltinESMExports();
    expect(records(await f.log.read())).toEqual([
      { ...first, traceSaved: true },
    ]);
  });

  it("does not save after cancellation while waiting for the writer lock", async () => {
    const f = fixture();
    await f.log.read();
    await new ProcessLock(join(f.path, "writer.sqlite")).runExclusive(
      "test",
      new AbortController().signal,
      async () => {
        const abort = new AbortController();
        const pending = f.log.save(record(), abort.signal);
        await new Promise((resolve) => setTimeout(resolve, 20));
        abort.abort();
        expect(await pending).toBe(false);
      },
    );
    expect(records(await f.log.read())).toEqual([]);
  });

  it("serializes concurrent processes near the rotation boundary into complete distinct records", async () => {
    const f = fixture();
    await f.log.read();
    const seed = line();
    fs.writeFileSync(
      f.current,
      seed.repeat(Math.floor((1024 * 1024) / Buffer.byteLength(seed))),
    );
    fs.writeFileSync(
      f.rotated,
      seed.repeat(Math.floor((1024 * 1024) / Buffer.byteLength(seed))),
    );
    const entry = join(f.directory, "writer.mjs");
    await build({
      entryPoints: [resolve("test/mcp/fixtures/failure-log-worker.ts")],
      outfile: entry,
      bundle: true,
      platform: "node",
      target: "node22",
      format: "esm",
      logLevel: "silent",
    });
    const results = await Promise.all(
      Array.from({ length: 4 }, () => run(entry, [f.path], process.env)),
    );
    for (const result of results) expect(result.status, result.stderr).toBe(0);
    const ids = results.flatMap((r) => JSON.parse(r.stdout) as string[]);
    expect(ids).toHaveLength(40);
    const saved = records(await f.log.read()).filter((r) =>
      ids.includes(r?.operationId ?? ""),
    );
    expect(saved).toHaveLength(40);
    expect(saved.map((r) => r?.operationId).sort()).toEqual(ids.sort());
    expect(new Set(ids).size).toBe(40);
  });
});
