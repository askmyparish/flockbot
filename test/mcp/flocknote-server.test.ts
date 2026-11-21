import { SerialCoordinator } from "../../adapters/mcp/src/serial-coordinator.js";
import {
  mkdtempSync,
  rmSync,
  realpathSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ParishConnection } from "../../adapters/mcp/src/connection.js";
import { createFlocknoteServer } from "../../adapters/mcp/src/flocknote-server.js";
import {
  ConnectionError,
  type SessionFactory,
  type FlocknoteSession,
} from "../../adapters/mcp/src/session.js";
import { waitFor } from "./support.js";
import { duplicationFixture } from "../fixtures/email-duplication.js";
import { FlockbotError } from "../../src/errors.js";
import {
  draftInput,
  draftResponse,
  htmlDraftInput,
  htmlDraftStored,
  blockDraftInput,
  blockDraftResponse,
} from "../fixtures/email-draft.js";
import {
  safeDiagnostic,
  recordResponse,
} from "../../adapters/mcp/src/diagnostics.js";
import { FailureLog } from "../../adapters/mcp/src/failure-log.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

async function fixture(
  options: {
    factory?: SessionFactory;
    signInWaitMs?: number;
    signInPollMs?: number;
    failureLog?: Pick<FailureLog, "save">;
    parish?: string;
    updateAvailable?: () => string | undefined;
  } = {},
) {
  const profile = mkdtempSync(join(tmpdir(), "flockbot-server-test-"));
  const connection = new ParishConnection({
    coordinator: new SerialCoordinator(),
    profile,
    pollMs: 5,
    setupMs: 5000,
    factory:
      options.factory ??
      (async () => {
        throw new Error("fictional-secret-never-returned");
      }),
  });
  const logDirectory = join(realpathSync(profile), "diagnostics-v1");
  const failureLog = new FailureLog({ directory: logDirectory });
  const server = createFlocknoteServer(connection, { failureLog, ...options });
  const client = new Client({ name: "fictional-codex", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  cleanup.push(async () => {
    await client.close();
    await connection.close();
    rmSync(profile, { recursive: true, force: true });
  });
  return { client, connection, failureLog, logDirectory };
}

describe("Flocknote MCP contract", () => {
  it("duplicates a selected email through MCP with safe unknown-write progress", async () => {
    const data = duplicationFixture();
    let fail = false;
    const f = await fixture({
      factory: async () => ({
        signIn: async () => {},
        close: async () => {},
        request: async (path, _method, body) => {
          if (fail && path === "composer/save2")
            throw new FlockbotError("transport_failed");
          return data.response(path, body);
        },
      }),
    });
    await f.connection.connect("example-parish");
    await waitFor(async () =>
      expect(await f.connection.status()).toMatchObject({ state: "ready" }),
    );
    expect(
      (
        await f.client.callTool({
          name: "duplicate_email_draft",
          arguments: { noteId: "801" },
        })
      ).structuredContent,
    ).toMatchObject({
      ok: true,
      sourceNoteId: "801",
      noteId: "803",
      groupIds: ["101", "102"],
      verified: true,
      url: "https://example-parish.flocknote.com/note/803",
    });
    data.source.status = "draft";
    const unsupported = await f.client.callTool({
      name: "duplicate_email_draft",
      arguments: { noteId: "801" },
    });
    expect(unsupported.structuredContent).toMatchObject({
      code: "draft_not_submitted",
      outcome: "not_submitted",
      diagnostic: { final: { reason: "duplicate_source_unsupported" } },
      message: expect.stringMatching(/^No draft was submitted\./),
    });
    data.source.status = "published";
    fail = true;
    const failure = await f.client.callTool({
      name: "duplicate_email_draft",
      arguments: { noteId: "801" },
    });
    expect(failure.structuredContent).toMatchObject({
      ok: false,
      outcome: "unknown",
      draftProgress: { stage: "materialize", autosaveId: "802" },
    });
    expect(JSON.stringify(failure)).not.toMatch(
      /The Choir|Annual choir|base64Gradient|photourl/,
    );
    expect(
      (
        await f.client.callTool({
          name: "duplicate_email_draft",
          arguments: { noteId: "801", subject: "Override" },
        })
      ).isError,
    ).toBe(true);
  });

  it("creates drafts through MCP and returns safe partial progress on failures", async () => {
    let fail = false;
    let html = false;
    let blocks = false;
    const blockResponse = blockDraftResponse();
    const f = await fixture({
      factory: async () => ({
        signIn: async () => {},
        close: async () => {},
        request: async (path, _method, body) => {
          if (fail && path === "composer/saveModule")
            throw new FlockbotError("transport_failed");
          if (blocks) return blockResponse(path, body);
          return draftResponse(path, body, html ? htmlDraftStored : undefined);
        },
      }),
    });
    await f.connection.connect("example-parish");
    await waitFor(async () =>
      expect(await f.connection.status()).toMatchObject({ state: "ready" }),
    );
    const success = await f.client.callTool({
      name: "create_email_draft",
      arguments: draftInput,
    });
    expect(success.structuredContent).toMatchObject({
      ok: true,
      noteId: "803",
      verified: true,
    });
    html = true;
    const formatted = await f.client.callTool({
      name: "create_email_draft",
      arguments: htmlDraftInput,
    });
    expect(formatted.structuredContent).toMatchObject({
      ok: true,
      verified: true,
      noteId: "803",
    });
    blocks = true;
    expect(
      (
        await f.client.callTool({
          name: "create_email_draft",
          arguments: blockDraftInput,
        })
      ).structuredContent,
    ).toMatchObject({ ok: true, verified: true });
    for (const input of [
      { ...blockDraftInput, body: "conflict" },
      {
        ...blockDraftInput,
        content: [
          { type: "button", text: "Private label", url: "javascript:alert(1)" },
        ],
      },
    ]) {
      const rejected = await f.client.callTool({
        name: "create_email_draft",
        arguments: input,
      });
      expect(rejected.structuredContent).toMatchObject({
        code: "invalid_input",
        outcome: "not_submitted",
      });
      expect(JSON.stringify(rejected)).not.toContain("Private label");
    }
    blocks = false;
    const invalid = await f.client.callTool({
      name: "create_email_draft",
      arguments: {
        ...htmlDraftInput,
        body: '<p style="color:red">private body</p>',
      },
    });
    expect(invalid.isError).toBe(true);
    expect(invalid.structuredContent).toMatchObject({
      code: "invalid_input",
      outcome: "not_submitted",
    });
    expect(JSON.stringify(invalid)).not.toContain("private body");
    fail = true;
    const failure = await f.client.callTool({
      name: "create_email_draft",
      arguments: htmlDraftInput,
    });
    expect(failure.isError).toBe(true);
    expect(failure.structuredContent).toMatchObject({
      ok: false,
      code: "transport_failed",
      outcome: "unknown",
      draftProgress: { stage: "module", autosaveId: "801" },
    });
    expect(JSON.stringify(failure)).not.toContain(draftInput.body);
    const extra = await f.client.callTool({
      name: "create_email_draft",
      arguments: { ...draftInput, noteId: "803" },
    });
    expect(extra.isError).toBe(true);
  });

  it("preserves successful and uncertain writes when verbose record assembly throws", async () => {
    const f = await fixture();
    const write = vi
      .spyOn(f.connection, "addMember")
      .mockResolvedValueOnce({ success: true })
      .mockRejectedValueOnce(
        new FlockbotError("transport_failed", undefined, "unknown"),
      );
    const original = JSON.stringify;
    const stringify = vi
      .spyOn(JSON, "stringify")
      .mockImplementation((value) => {
        if (value?.kind === "verbose")
          throw new Error("fictional capture failure");
        return original(value);
      });
    try {
      const args = {
        groupId: "101",
        firstName: "Alex",
        lastName: "Example",
        email: "alex@example.test",
        verboseDiagnostics: true,
      };
      const success = await f.client.callTool({
        name: "add_member",
        arguments: args,
      });
      expect(success.structuredContent).toMatchObject({
        ok: true,
        success: true,
        verboseDiagnostic: { traceSaved: false, available: false },
      });
      const failure = await f.client.callTool({
        name: "add_member",
        arguments: args,
      });
      expect(failure.structuredContent).toMatchObject({
        ok: false,
        code: "transport_failed",
        outcome: "unknown",
        verboseDiagnostic: { traceSaved: false, available: false },
      });
      expect(write).toHaveBeenCalledTimes(2);
    } finally {
      stringify.mockRestore();
    }
  });

  it.each([undefined, false, true])(
    "uses one safe failure contract for every tool without sharing operation IDs (verbose %s)",
    async (verboseDiagnostics) => {
      const { client, connection, failureLog, logDirectory } = await fixture();
      expect((await client.callTool({ name: "status" })).isError).not.toBe(
        true,
      );
      expect(existsSync(logDirectory)).toBe(false);
      const calls = [
        ["status", "status", {}],
        ["connect", "connect", { subdomain: "example-parish" }],
        ["groups", "groups", {}],
        ["subscriber_count", "count", { groupId: "101" }],
        ["member_filters", "memberFilters", { groupId: "101" }],
        [
          "find_members",
          "findMembers",
          { searchTerm: "Private Sentinel", groupId: "101" },
        ],
        ["member", "member", { userId: "301" }],
        ["member_groups", "memberGroups", { userId: "301" }],
        ["group_members", "groupMembers", { groupId: "101" }],
        [
          "member_communication_status",
          "memberCommunicationStatus",
          { userId: "301", groupId: "101" },
        ],
        ["email_analytics", "emailAnalytics", { emailId: "801" }],
        [
          "email_recipients",
          "emailRecipients",
          { emailId: "801", category: "opened" },
        ],
        [
          "member_latest_email_status",
          "memberLatestEmailStatus",
          { userId: "301", groupId: "101" },
        ],
        ["is_member", "isMember", { userId: "301", groupId: "101" }],
        [
          "add_member",
          "addMember",
          {
            groupId: "101",
            firstName: "Private",
            lastName: "Sentinel",
            email: "private@example.test",
          },
        ],
      ] as const;
      const ids = new Set<string>();
      for (const [name, method, args] of calls) {
        const error =
          name === "subscriber_count"
            ? new FlockbotError(
                "invalid_response",
                200,
                undefined,
                undefined,
                "subscriber_count_invalid",
              )
            : new Error(
                "Private Sentinel password cookie private@example.test",
              );
        const spy = vi.spyOn(connection, method).mockRejectedValue(error);
        const response = await client.callTool({
          name,
          arguments: {
            ...args,
            ...(verboseDiagnostics === undefined ? {} : { verboseDiagnostics }),
          },
        });
        expect(response.isError).toBe(true);
        const diagnostic = safeDiagnostic(
          (response.structuredContent as Record<string, unknown> | undefined)
            ?.diagnostic,
        );
        if (!diagnostic) throw new Error("Missing safe diagnostic");
        expect(diagnostic).toMatchObject({
          operation: name,
          traceSaved: true,
          browserRuntime: null,
        });
        expect(diagnostic?.failure).toMatchObject({
          reason:
            name === "subscriber_count"
              ? "subscriber_count_invalid"
              : "unknown_failure",
        });
        expect(JSON.stringify(response)).not.toMatch(
          /Private|Sentinel|password|cookie|private@example/,
        );
        expect(diagnostic?.operationId).toBeTruthy();
        expect(ids.has(diagnostic.operationId)).toBe(false);
        ids.add(diagnostic.operationId);
        expect(
          (response.structuredContent as Record<string, unknown>)
            .verboseDiagnostic,
        ).toEqual(
          verboseDiagnostics
            ? {
                operationId: diagnostic.operationId,
                traceSaved: true,
                available: true,
                truncated: false,
              }
            : undefined,
        );
        spy.mockRestore();
      }
      expect(ids.size).toBe(calls.length);
      const stored = (await failureLog.read())
        ?.trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(stored?.map((record) => record.operationId).sort()).toEqual(
        [...ids].sort(),
      );
      expect(
        stored?.every(
          (record) => record.version === (verboseDiagnostics ? 2 : 1),
        ),
      ).toBe(true);
      expect(
        readFileSync(join(logDirectory, "failures.jsonl"), "utf8"),
      ).not.toMatch(/Private|Sentinel|password|cookie|private@example/);
    },
  );

  it.each([false, true])(
    "saves payloads only for explicit successful calls and preserves results on storage failure (%s)",
    async (loggingFails) => {
      const f = await fixture(
        loggingFails
          ? {
              failureLog: {
                save: async () => {
                  throw new Error("fictional disk error");
                },
              },
            }
          : {},
      );
      const count = vi
        .spyOn(f.connection, "count")
        .mockImplementation(async () => {
          await Promise.resolve();
          recordResponse(
            "group/101/getSubscriberCount",
            "GET",
            {
              contentType: "json",
              data: {
                subscriberCount: 7,
                email: "alex@example.test",
                token: "EXCLUDE_ME_73",
              },
            },
            1,
          );
          return 7;
        });
      const results = await Promise.all(
        [true, false, undefined].map((verboseDiagnostics) =>
          f.client.callTool({
            name: "subscriber_count",
            arguments: {
              groupId: "101",
              ...(verboseDiagnostics === undefined
                ? {}
                : { verboseDiagnostics }),
            },
          }),
        ),
      );
      for (const result of results) {
        expect(result.structuredContent).toMatchObject({
          ok: true,
          subscriberCount: 7,
        });
        expect(JSON.stringify(result)).not.toMatch(
          /alex@example|EXCLUDE_ME_73|exchanges/,
        );
      }
      expect(results[0]?.structuredContent).toMatchObject({
        verboseDiagnostic: { traceSaved: !loggingFails, available: true },
      });
      expect(results[1]?.structuredContent).not.toHaveProperty(
        "verboseDiagnostic",
      );
      expect(results[2]?.structuredContent).not.toHaveProperty(
        "verboseDiagnostic",
      );
      expect(count).toHaveBeenCalledTimes(3);
      const text = await f.failureLog.read();
      expect(text).not.toContain("EXCLUDE_ME_73");
      if (loggingFails) expect(text).toBe("");
      else {
        const records = text
          ?.trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(records).toHaveLength(1);
        if (!results[0]) throw new Error("Missing tool result");
        expect(records?.[0]).toMatchObject({
          kind: "verbose",
          outcome: "success",
          operationId: (
            results[0].structuredContent as {
              verboseDiagnostic: { operationId: string };
            }
          ).verboseDiagnostic.operationId,
        });
        expect(text).toContain("alex@example.test");
      }
    },
  );

  it.each([false, true])(
    "preserves an unknown write outcome with successful or failed logging (%s)",
    async (loggingFails) => {
      const { client, connection, failureLog } = await fixture({
        ...(loggingFails
          ? {
              failureLog: {
                save: async () => {
                  throw new Error("PRIVATE disk failure");
                },
              },
            }
          : {}),
      });
      vi.spyOn(connection, "addMember").mockRejectedValue(
        new ConnectionError("connection_busy", "unknown"),
      );
      const result = await client.callTool({
        name: "add_member",
        arguments: {
          groupId: "101",
          firstName: "Alex",
          lastName: "Example",
          email: "alex@example.test",
        },
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        ok: false,
        code: "connection_busy",
        outcome: "unknown",
        diagnostic: {
          traceSaved: !loggingFails,
          final: { stage: "connection" },
        },
      });
      if (!loggingFails) {
        const records = (await failureLog.read())
          ?.trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(records).toEqual([
          (result.structuredContent as Record<string, unknown>).diagnostic,
        ]);
      }
      expect(connection.addMember).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(result)).not.toContain("alex@");
    },
  );

  it("names the signed-in parish in instructions and in each result", async () => {
    const { client, connection } = await fixture({ parish: "first-parish" });
    expect(client.getInstructions()).toMatch(
      /^This computer is signed in to the Flocknote parish first-parish \(first-parish\.flocknote\.com\)\./,
    );
    // Results use the saved connection now, not the parish at startup.
    vi.spyOn(connection, "status").mockResolvedValue({
      state: "ready",
      parish: "second-parish",
    });
    vi.spyOn(connection, "count").mockResolvedValue(7);
    expect(
      (
        await client.callTool({
          name: "subscriber_count",
          arguments: { groupId: "101" },
        })
      ).structuredContent,
    ).toEqual({
      ok: true,
      groupId: "101",
      subscriberCount: 7,
      parish: "second-parish",
    });
    const { client: unsigned } = await fixture();
    expect(unsigned.getInstructions()).not.toMatch(
      /signed in to the Flocknote parish/,
    );
  });

  it("mentions an available update once per session, and in every status", async () => {
    let available: string | undefined;
    const { client, connection } = await fixture({
      updateAvailable: () => available,
    });
    vi.spyOn(connection, "status").mockResolvedValue({
      state: "ready",
      parish: "example-parish",
    });
    vi.spyOn(connection, "count").mockResolvedValue(7);
    const count = async () =>
      (
        await client.callTool({
          name: "subscriber_count",
          arguments: { groupId: "101" },
        })
      ).structuredContent as Record<string, unknown>;
    const status = async () =>
      (await client.callTool({ name: "status", arguments: {} }))
        .structuredContent as Record<string, unknown>;

    // Nothing to mention until a check finds a release, even mid-session.
    expect(await count()).not.toHaveProperty("update");
    available = "0.3.0";
    expect(await count()).toMatchObject({
      subscriberCount: 7,
      update: {
        version: "0.3.0",
        message: expect.stringContaining("open the Flockbot app"),
      },
    });
    expect(await count()).not.toHaveProperty("update");
    expect(await status()).toMatchObject({ update: { version: "0.3.0" } });
    expect(await status()).toMatchObject({ update: { version: "0.3.0" } });
  });

  it("holds connect until fictional sign-in completes, then allows the original Everyone count without a user-done message", async () => {
    let finishLogin = (_value: unknown) => {};
    const login = new Promise<unknown>((resolve) => {
      finishLogin = resolve;
    });
    const events: string[] = [];
    const session: FlocknoteSession = {
      signIn: vi.fn(async () => {
        events.push("window_opened");
      }),
      finishSignIn: vi.fn(async () => {
        events.push("window_hidden");
      }),
      close: vi.fn(async () => undefined),
      isOpen: () => true,
      request: vi.fn(async (path) => {
        if (path === "user/userData") return login;
        if (path === "dashboard") return '<div id="fnReactHolder"></div>';
        if (path === "navigation/groups") return { groups: [] };
        if (path === "network/getMetadata") return { everyoneGroupID: 101 };
        if (path === "group/101/getSubscriberCount")
          return { subscriberCount: "7" };
        throw new Error("Unexpected fictional request");
      }),
    };
    const { client, connection } = await fixture({
      factory: async () => session,
      signInWaitMs: 5000,
      signInPollMs: 5,
    });
    try {
      const first = await client.callTool({ name: "groups" });
      expect(first.structuredContent).toMatchObject({
        ok: false,
        code: "not_configured",
      });
      const status = vi.spyOn(connection, "status");
      let returned = false;
      const connecting = client
        .callTool({
          name: "connect",
          arguments: { subdomain: "example-parish" },
        })
        .then((result) => {
          returned = true;
          events.push("connect_returned");
          return result;
        });
      await waitFor(() =>
        expect(status.mock.calls.length).toBeGreaterThanOrEqual(2),
      );
      expect(returned).toBe(false);
      expect(events).toEqual(["window_opened"]);
      // Polling saved status adds no Flocknote requests to the single in-flight login check.
      expect(session.request).toHaveBeenCalledTimes(1);
      finishLogin({ success: true, userID: 201 });
      const connected = await connecting;
      expect(connected.structuredContent).toMatchObject({
        ok: true,
        state: "ready",
        parish: "example-parish",
        message: expect.stringContaining("original request"),
      });
      expect(events).toEqual([
        "window_opened",
        "window_hidden",
        "connect_returned",
      ]);
      const groups = await client.callTool({ name: "groups" });
      expect(groups.structuredContent).toMatchObject({
        groups: [expect.objectContaining({ id: "101", isEveryone: true })],
      });
      const count = await client.callTool({
        name: "subscriber_count",
        arguments: { groupId: "101" },
      });
      expect(count.structuredContent).toMatchObject({
        ok: true,
        subscriberCount: 7,
      });
      expect(JSON.stringify(connected)).not.toMatch(
        /userID|cookie|password|flockbot-server-test-/,
      );
      expect(client.getInstructions()).toContain(
        "continue the user's original request",
      );
      expect(client.getInstructions()).toContain(
        "Never repeat a write with outcome unknown",
      );
    } finally {
      finishLogin({ success: true, userID: 201 });
    }
  });

  it("returns an already-ready connect immediately without polling saved status", async () => {
    const { client, connection } = await fixture();
    vi.spyOn(connection, "connect").mockResolvedValue({
      state: "ready",
      parish: "example-parish",
    });
    const status = vi.spyOn(connection, "status");
    const result = await client.callTool({
      name: "connect",
      arguments: { subdomain: "example-parish" },
    });
    expect(result.structuredContent).toMatchObject({
      state: "ready",
      message: expect.stringContaining("original request"),
    });
    expect(status).not.toHaveBeenCalled();
  });

  it("returns truthful pending on a bounded wait even if a status dependency ignores abort", async () => {
    const { client, connection } = await fixture({
      signInWaitMs: 30,
      signInPollMs: 5,
    });
    vi.spyOn(connection, "connect").mockResolvedValue({
      state: "pending",
      parish: "example-parish",
    });
    let finishStatus = (
      _value: Awaited<ReturnType<ParishConnection["status"]>>,
    ) => {};
    vi.spyOn(connection, "status").mockImplementation(
      () =>
        new Promise((resolve) => {
          finishStatus = resolve;
        }),
    );
    const result = await client.callTool({
      name: "connect",
      arguments: { subdomain: "example-parish" },
    });
    expect(result.structuredContent).toMatchObject({
      ok: true,
      state: "pending",
      message: expect.stringContaining("Finish sign-in"),
    });
    finishStatus({ state: "ready", parish: "example-parish" });
  });

  it("cancels waiting without closing or forgetting the browser connection", async () => {
    const { client, connection, failureLog } = await fixture({
      signInWaitMs: 5000,
      signInPollMs: 5,
    });
    vi.spyOn(connection, "connect").mockResolvedValue({
      state: "pending",
      parish: "example-parish",
    });
    let statusSignal: AbortSignal | undefined;
    let finishStatus = (
      _value: Awaited<ReturnType<ParishConnection["status"]>>,
    ) => {};
    vi.spyOn(connection, "status").mockImplementation((options) => {
      statusSignal = options?.signal;
      return new Promise((resolve) => {
        finishStatus = resolve;
      });
    });
    const close = vi.spyOn(connection, "close");
    const controller = new AbortController();
    const pending = client.callTool(
      { name: "connect", arguments: { subdomain: "example-parish" } },
      undefined,
      { signal: controller.signal },
    );
    const rejection = expect(pending).rejects.toThrow();
    await waitFor(() => expect(statusSignal).toBeDefined());
    controller.abort();
    await rejection;
    await waitFor(() => expect(statusSignal?.aborted).toBe(true));
    expect(close).not.toHaveBeenCalled();
    finishStatus({ state: "ready", parish: "example-parish" });
    await waitFor(async () => {
      const saved = (await failureLog.read())
        ?.trim()
        .split("\n")
        .filter(Boolean);
      expect(saved).toHaveLength(1);
      expect(JSON.parse(saved?.[0] ?? "null")).toMatchObject({
        operation: "connect",
        traceSaved: true,
        final: { code: "operation_cancelled" },
      });
    });
  });

  it("returns the original cancellation when logging stalls and prevents a late save", async () => {
    let finish = () => {};
    let lateSave: Promise<boolean> | undefined;
    const f = await fixture({
      failureLog: {
        save: async (record, signal) => {
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
          lateSave = f.failureLog.save(record, signal);
          return lateSave;
        },
      },
    });
    vi.spyOn(f.connection, "status").mockRejectedValue(
      new FlockbotError("operation_cancelled"),
    );
    const result = await f.client.callTool(
      { name: "status", arguments: { verboseDiagnostics: true } },
      undefined,
      {
        timeout: 3000,
      },
    );
    expect(result.structuredContent).toMatchObject({
      ok: false,
      code: "operation_cancelled",
      diagnostic: {
        traceSaved: false,
        final: { code: "operation_cancelled" },
      },
    });
    finish();
    await waitFor(() => expect(lateSave).toBeDefined());
    expect(await lateSave).toBe(false);
    expect(await f.failureLog.read()).toBe("");
  });

  it("returns pending when the polling interval is interrupted by its wait deadline", async () => {
    const { client, connection } = await fixture({
      signInWaitMs: 30,
      signInPollMs: 50,
    });
    vi.spyOn(connection, "connect").mockResolvedValue({
      state: "pending",
      parish: "example-parish",
    });
    vi.spyOn(connection, "status").mockResolvedValue({
      state: "pending",
      parish: "example-parish",
    });
    const close = vi.spyOn(connection, "close");
    const result = await client.callTool({
      name: "connect",
      arguments: { subdomain: "example-parish" },
    });
    expect(result.structuredContent).toMatchObject({
      ok: true,
      state: "pending",
    });
    expect(result.isError).toBeUndefined();
    expect(close).not.toHaveBeenCalled();
  });

  it.each([
    {
      state: "action_required" as const,
      parish: "example-parish",
      setupError: "browser_unavailable" as const,
    },
    { state: "not_configured" as const },
  ])(
    "returns terminal saved state $state without claiming sign-in succeeded",
    async (saved) => {
      const { client, connection } = await fixture({
        signInWaitMs: 5000,
        signInPollMs: 5,
      });
      vi.spyOn(connection, "connect").mockResolvedValue({
        state: "pending",
        parish: "example-parish",
      });
      vi.spyOn(connection, "status").mockResolvedValue(saved);
      const result = await client.callTool({
        name: "connect",
        arguments: { subdomain: "example-parish" },
      });
      expect(result.structuredContent).toMatchObject({ state: saved.state });
      expect(JSON.stringify(result)).not.toContain("Sign-in is complete");
    },
  );

  it("refuses a parish change while waiting instead of resuming against another connection", async () => {
    const { client, connection } = await fixture({
      signInWaitMs: 5000,
      signInPollMs: 5,
    });
    vi.spyOn(connection, "connect").mockResolvedValue({
      state: "pending",
      parish: "example-parish",
    });
    vi.spyOn(connection, "status").mockResolvedValue({
      state: "ready",
      parish: "another-example",
    });
    const result = await client.callTool({
      name: "connect",
      arguments: { subdomain: "example-parish" },
    });
    expect(result.structuredContent).toMatchObject({
      ok: false,
      code: "connection_changed",
    });
    expect(result.isError).toBe(true);
  });

  it("bounds initial connect too and sanitizes status failures", async () => {
    const first = await fixture({ signInWaitMs: 30, signInPollMs: 5 });
    let finishConnect = (
      _value: Awaited<ReturnType<ParishConnection["connect"]>>,
    ) => {};
    vi.spyOn(first.connection, "connect").mockImplementation(
      () =>
        new Promise((resolve) => {
          finishConnect = resolve;
        }),
    );
    const timedOut = await first.client.callTool({
      name: "connect",
      arguments: { subdomain: "example-parish" },
    });
    expect(timedOut.structuredContent).toMatchObject({
      ok: false,
      code: "operation_timeout",
    });
    finishConnect({ state: "pending", parish: "example-parish" });
    const next = await fixture();
    vi.spyOn(next.connection, "connect").mockResolvedValue({
      state: "pending",
      parish: "example-parish",
    });
    vi.spyOn(next.connection, "status").mockRejectedValue(
      new ConnectionError("profile_unavailable"),
    );
    const failed = await next.client.callTool({
      name: "connect",
      arguments: { subdomain: "example-parish" },
    });
    expect(failed.structuredContent).toMatchObject({
      ok: false,
      code: "profile_unavailable",
    });
  });

  it("routes a named addition directly and requires exactly one group selector", async () => {
    const { client, connection } = await fixture();
    const add = vi
      .spyOn(connection, "addMemberByName")
      .mockResolvedValue({ success: true });
    const groups = vi.spyOn(connection, "groups");
    const member = {
      firstName: "Alex",
      lastName: "Rivera",
      email: "alex@example.test",
    };
    const result = await client.callTool({
      name: "add_member",
      arguments: { groupName: "Volunteers", ...member },
    });
    expect(result.structuredContent).toEqual({ ok: true, success: true });
    expect(add).toHaveBeenCalledWith(
      "Volunteers",
      member,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(groups).not.toHaveBeenCalled();
    for (const selector of [{}, { groupId: "102", groupName: "Volunteers" }]) {
      const invalid = await client.callTool({
        name: "add_member",
        arguments: { ...selector, ...member },
      });
      expect(invalid.structuredContent).toMatchObject({
        ok: false,
        code: "invalid_input",
        outcome: "not_submitted",
      });
    }
    expect(add).toHaveBeenCalledTimes(1);
  });

  it("advertises only defined parish operations with safe schemas and write annotations", async () => {
    const { client } = await fixture();
    const { tools } = await client.listTools();
    expect(tools.map(({ name }) => name).sort()).toEqual([
      "add_member",
      "connect",
      "create_email_draft",
      "duplicate_email_draft",
      "email_analytics",
      "email_recipients",
      "find_members",
      "find_notes",
      "group_members",
      "group_notes",
      "groups",
      "is_member",
      "member",
      "member_communication_status",
      "member_filters",
      "member_groups",
      "member_latest_email_status",
      "note",
      "status",
      "subscriber_count",
    ]);
    for (const tool of tools) {
      const schema = JSON.stringify(tool.inputSchema).replaceAll(
        '"description":',
        '"documentation":',
      );
      expect(schema).not.toMatch(/password|cookie|token|script|code/i);
      if (tool.name !== "create_email_draft")
        expect(schema).not.toMatch(/url/i);
    }
    // A button destination is content, not an arbitrary request endpoint.
    expect(
      tools
        .filter((tool) => /"url":/.test(JSON.stringify(tool.inputSchema)))
        .map((tool) => tool.name),
    ).toEqual(["create_email_draft"]);
    // Codex versions that cannot normalize oneOf array items need anyOf here.
    expect(
      tools.find(({ name }) => name === "create_email_draft")?.inputSchema,
    ).toMatchObject({
      properties: {
        content: {
          items: {
            anyOf: [
              { type: "object", properties: { type: { const: "text" } } },
              { type: "object", properties: { type: { const: "button" } } },
              { type: "object", properties: { type: { const: "image" } } },
            ],
          },
        },
      },
    });
    expect(
      tools.find(({ name }) => name === "add_member")?.annotations,
    ).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    });
    expect(
      tools.find(({ name }) => name === "create_email_draft")?.annotations,
    ).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    });
    expect(
      tools.find(({ name }) => name === "duplicate_email_draft")?.annotations,
    ).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    });
    expect(client.getInstructions()).toMatch(
      /Never repeat a write with outcome unknown/,
    );
  });

  it("names Flockbot's own sign-in, not Flocknote's website, as where sign-in happens", async () => {
    const website = /Flocknote's (?:real )?website|Flocknote browser window/;
    // Sign-in stays open: the person has not finished it yet.
    const waiting = {
      factory: async () => ({
        signIn: async () => {},
        close: async () => {},
        request: async () => {
          throw new FlockbotError("authentication_required");
        },
      }),
      signInWaitMs: 30,
      signInPollMs: 5,
    };
    const local = await fixture(waiting);
    const text = async (client: typeof local.client) => [
      client.getInstructions() ?? "",
      (await client.listTools()).tools.find(({ name }) => name === "connect")
        ?.description ?? "",
      JSON.stringify(
        (
          await client.callTool({
            name: "connect",
            arguments: { subdomain: "example-parish" },
          })
        ).structuredContent,
      ),
    ];
    for (const part of await text(local.client)) {
      expect(part).toContain("Flockbot's sign-in");
      expect(part).not.toMatch(website);
    }
  });

  it.each([
    "flocknote_status",
    "flocknote_connect",
    "flocknote_groups",
    "flocknote_group_members",
    "flocknote_subscriber_count",
    "flocknote_add_member",
    "flocknote_find_members",
    "flocknote_member",
    "flocknote_member_groups",
    "flocknote_is_member",
  ])("does not expose the removed prefixed tool %s", async (name) => {
    const { client } = await fixture();
    expect(await client.callTool({ name })).toMatchObject({
      isError: true,
      content: [
        {
          type: "text",
          text: expect.stringContaining(`Tool ${name} not found`),
        },
      ],
    });
  });

  it("returns nonsecret status and fixed setup errors through real MCP messages", async () => {
    const { client, connection } = await fixture();
    const status = await client.callTool({ name: "status" });
    expect(status.structuredContent).toMatchObject({
      ok: true,
      state: "not_configured",
    });
    const failed = await client.callTool({
      name: "connect",
      arguments: { subdomain: "example-parish" },
    });
    expect(failed.isError).toBe(true);
    expect(JSON.stringify(failed)).not.toContain("fictional-secret");
    expect(JSON.stringify(failed)).not.toContain("flockbot-server-test-");
    expect(await connection.status()).toMatchObject({
      state: "action_required",
      parish: "example-parish",
      setupError: "browser_unavailable",
    });
    const afterFailure = await client.callTool({ name: "status" });
    expect(afterFailure.structuredContent).toMatchObject({
      setupError: "browser_unavailable",
      message: expect.stringContaining("Sign in again using connect"),
    });
  });

  it.each([
    ["operation_timeout", "The operation timed out."],
    ["redirect_rejected", "Flocknote redirected the request."],
    ["invalid_response", "Flocknote returned an unexpected response."],
    [
      "connection_changed",
      "Flocknote login differs from the saved connection.",
    ],
  ] as const)(
    "keeps recovery guidance alongside the setup diagnostic (%s)",
    async (setupError, diagnostic) => {
      const { client, connection } = await fixture();
      vi.spyOn(connection, "status").mockResolvedValue({
        state: "action_required",
        parish: "example-parish",
        setupError,
      });
      vi.spyOn(connection, "connect").mockResolvedValue({
        state: "action_required",
        parish: "example-parish",
        setupError,
      });
      for (const name of ["status", "connect"]) {
        const response = await client.callTool({
          name,
          ...(name === "connect"
            ? { arguments: { subdomain: "example-parish" } }
            : {}),
        });
        expect(response.structuredContent).toMatchObject({
          state: "action_required",
          setupError,
          message: expect.stringContaining(diagnostic),
        });
        expect(response.structuredContent).toMatchObject({
          message: expect.stringContaining("Sign in again using connect"),
        });
      }
    },
  );

  it("never includes contact-bearing exception details in a tool failure", async () => {
    const { client, connection } = await fixture();
    vi.spyOn(connection, "groups").mockRejectedValue(
      new Error("alex@example.test; fictional-password"),
    );
    const result = await client.callTool({ name: "groups" });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/alex@|fictional-password/);
  });
});
