import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  diagnosticOperationId,
  receiveVerboseDiagnostic,
  runDiagnostic,
  verboseDiagnostic,
} from "../../adapters/mcp/src/diagnostics.js";
import { createFlocknoteServer } from "../../adapters/mcp/src/flocknote-server.js";
import {
  parseDevelopmentArgs,
  readDevelopmentInput,
  runLiveRead,
} from "../../scripts/mcp/develop.mjs";
import { FlockbotError } from "../../src/errors.js";

function fixture() {
  const identity = { version: "0.2.1-dev.13", fingerprint: "a".repeat(64) };
  const state = {
    parish: "example-parish",
    readiness: "ready",
    owner: identity,
    fail: false,
    requests: [],
    stops: 0,
    records: [],
  };
  const runtime = {
    diagnosticRuntime: identity,
    runDiagnostic,
    verboseDiagnostic,
    createFlocknoteServer,
  };
  const connection = {
    async status() {
      receiveVerboseDiagnostic({
        version: 2,
        kind: "verbose",
        operationId: diagnosticOperationId(),
        observedAt: new Date().toISOString(),
        operation: "status",
        runtime: state.owner,
        browserRuntime: state.owner,
        outcome: "success",
        available: true,
        exchanges: [],
        truncated: false,
        traceSaved: false,
      });
      return { state: state.readiness, parish: state.parish };
    },
    async count(id) {
      state.requests.push(id);
      if (state.fail) throw new FlockbotError("permission_denied");
      return 4717;
    },
    async shutdown() {
      state.stops++;
      state.owner = identity;
    },
    async close() {},
  };
  const options = parseDevelopmentArgs([
    "--live",
    "--parish",
    "example-parish",
    "--tool",
    "subscriber_count",
  ]);
  const run = (overrides = {}, input = { groupId: "101" }) =>
    runLiveRead({ ...options, ...overrides }, input, runtime, connection, {
      async save(record) {
        state.records.push(record);
        return true;
      },
    });
  return { state, run, identity };
}

describe("explicit read-only development runner", () => {
  it("defaults offline and rejects writes, lifecycle tools and missing live consent", () => {
    expect(parseDevelopmentArgs([])).toEqual({ mode: "offline" });
    expect(parseDevelopmentArgs(["--help"])).toEqual({ mode: "help" });
    for (const tool of ["group_notes", "find_notes", "note"]) {
      expect(() => parseDevelopmentArgs(["--tool", tool])).toThrow();
      expect(
        parseDevelopmentArgs([
          "--live",
          "--parish",
          "example-parish",
          "--tool",
          tool,
        ]),
      ).toMatchObject({ mode: "live", tool });
    }
    for (const args of [
      ["--tool", "subscriber_count"],
      ["--restart-owner"],
      ["--verbose"],
      ["--live", "--tool", "status"],
      ...["add_member", "connect", "forget", "shutdown", "unknown"].map(
        (tool) => ["--live", "--parish", "example-parish", "--tool", tool],
      ),
    ])
      expect(() => parseDevelopmentArgs(args)).toThrow();
  });

  it("accepts only bounded JSON objects and keeps malformed input out of errors", ({
    onTestFinished,
  }) => {
    const dir = mkdtempSync(join(tmpdir(), "flockbot-development-input-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, "input.json");
    for (const text of [
      "SECRET",
      "null",
      "[]",
      '{"verboseDiagnostics":true}',
      `"${"x".repeat(17000)}"`,
    ]) {
      writeFileSync(path, text);
      expect(() => readDevelopmentInput(path)).toThrow(/Input must be/);
      expect(() => readDevelopmentInput(path)).not.toThrow(/SECRET/);
    }
    writeFileSync(path, '{"groupId":"101"}');
    expect(readDevelopmentInput(path)).toEqual({ groupId: "101" });
  });

  it("stops before a parish read on wrong parish, non-ready state, stale owner or bypassed consent", async () => {
    for (const change of [
      { parish: "other-parish" },
      { readiness: "pending" },
      { readiness: "action_required" },
      { owner: { version: "0.2.1-dev.13", fingerprint: "b".repeat(64) } },
    ]) {
      const f = fixture();
      Object.assign(f.state, change);
      await expect(f.run()).rejects.toThrow();
      expect(f.state.requests).toEqual([]);
      if (change.owner) expect(f.state.stops).toBe(0);
    }
    const f = fixture();
    for (const override of [
      { live: false },
      { tool: "add_member" },
      { tool: "connect" },
    ])
      await expect(f.run(override)).rejects.toThrow();
    await expect(f.run({}, { verboseDiagnostics: true })).rejects.toThrow();
    expect(f.state.requests).toEqual([]);
    expect(f.state.stops).toBe(0);
  });

  it("restarts only with consent, performs one MCP read, and stops the development owner", async () => {
    const f = fixture();
    f.state.owner = { ...f.identity, fingerprint: "b".repeat(64) };
    expect(await f.run({ "restart-owner": true })).toMatchObject({
      runtime: f.identity,
      tool: "subscriber_count",
      result: { ok: true, subscriberCount: 4717, groupId: "101" },
    });
    expect(f.state.requests).toEqual(["101"]);
    expect(f.state.stops).toBe(2);
    expect(f.state.records).toEqual([]);
  });

  it("does not retry failures and captures successful reads only with explicit verbose consent", async () => {
    const f = fixture();
    f.state.fail = true;
    expect(await f.run()).toMatchObject({
      result: { ok: false, code: "permission_denied" },
    });
    expect(f.state.requests).toEqual(["101"]);
    expect(f.state.stops).toBe(1);
    const verbose = fixture();
    expect(await verbose.run({ verbose: true })).toMatchObject({
      result: { ok: true, verboseDiagnostic: { traceSaved: true } },
    });
    expect(verbose.state.records).toHaveLength(1);
    expect(verbose.state.records[0]).toMatchObject({
      kind: "verbose",
      outcome: "success",
    });
  });
});
