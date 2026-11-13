import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserConnection } from "../../adapters/mcp/src/browser-connection.js";
import { createFlocknoteServer } from "../../adapters/mcp/src/flocknote-server.js";
import { brokerRequestSchema } from "../../adapters/mcp/src/browser-protocol.js";
import { SerialCoordinator } from "../../adapters/mcp/src/serial-coordinator.js";
import type { BrowserSession } from "../../adapters/mcp/src/browser-runtime.js";
import { searchMetadata, searchRow } from "../fixtures/member-search.js";
import { filterCatalog } from "../fixtures/member-filters.js";
import { profileResponse } from "../fixtures/member-profile.js";
import { membershipResponse } from "../fixtures/member-groups.js";
import { latestEmailResponses } from "../fixtures/latest-email.js";
import { noteSearchResponse } from "../fixtures/note-search.js";
import { noteResponse } from "../fixtures/note.js";
import { recipientPage } from "../fixtures/email-recipients.js";
import {
  AuthenticationSuspectedError,
  FlockbotError,
} from "../../src/errors.js";
import { waitFor } from "./support.js";
import { recordResponse } from "../../adapters/mcp/src/diagnostics.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

async function fixture(failureLog?: {
  save(value: unknown): Promise<boolean>;
}) {
  const profile = mkdtempSync(join(tmpdir(), "flockbot-member-search-"));
  writeFileSync(
    join(profile, "connection.json"),
    JSON.stringify({
      version: 1,
      generation: randomUUID(),
      parish: "example-parish",
      userId: "201",
      state: "ready",
    }),
    { mode: 0o600 },
  );
  const state: {
    catalog: unknown;
    response: unknown;
    verification: unknown;
    everyoneGroupID: number | null;
    profile: unknown;
    memberships: unknown;
    navigation: unknown;
    notes: unknown;
    note: unknown;
    recipients: unknown;
    latestEmail: Record<string, unknown>;
  } = {
    catalog: searchMetadata(),
    response: { success: true, results: [searchRow()], resultCount: 1 },
    verification: { success: true, userID: 201 },
    everyoneGroupID: 101,
    profile: profileResponse(),
    memberships: membershipResponse(),
    navigation: { groups: [] },
    notes: noteSearchResponse(),
    note: noteResponse(),
    recipients: recipientPage(),
    latestEmail: latestEmailResponses(),
  };
  const session: BrowserSession = {
    signIn: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    request: vi.fn(async (path) => {
      if (path === "user/userData") return state.verification;
      if (path === "dashboard") return '<div id="fnReactHolder"></div>';
      if (path === "navigation/groups") return state.navigation;
      if (path === "network/getMetadata")
        return {
          success: true,
          networkID: 201,
          everyoneGroupID: state.everyoneGroupID,
        };
      if (path === "supersearch/query?ajax") {
        if (state.notes instanceof Error) throw state.notes;
        return state.notes;
      }
      if (path === "composer/editNote") {
        if (state.note instanceof Error) throw state.note;
        return state.note;
      }
      if (path === "note/801/detailedAnalytics?ajax") {
        if (state.recipients instanceof Error) throw state.recipients;
        return state.recipients;
      }
      if (path === "group/101/people?ajax") {
        if (state.catalog instanceof Error) throw state.catalog;
        return state.catalog;
      }
      if (path === "group/101/filter") {
        if (state.response instanceof Error) throw state.response;
        return state.response;
      }
      if (path === "user/301/profile") {
        if (state.profile instanceof Error) throw state.profile;
        return state.profile;
      }
      if (path === "user/301/groups") {
        if (state.memberships instanceof Error) throw state.memberships;
        return state.memberships;
      }
      if (Object.hasOwn(state.latestEmail, path)) {
        const value = state.latestEmail[path];
        if (value instanceof Error) throw value;
        return value;
      }
      throw new Error("Unexpected fictional request");
    }),
  };
  const factory = vi.fn(async () => session);
  const connection = new BrowserConnection({
    profile,
    factory,
    coordinator: new SerialCoordinator(),
  });
  const server = createFlocknoteServer(connection, {
    ...(failureLog ? { failureLog } : {}),
    updates: {
      touch: vi.fn(),
      notice: () => ({
        availableVersion: "0.3.0",
        installedVersion: "0.2.0",
        prerelease: false,
        guideUrl: "https://example.test/guide",
        message: "Update available",
      }),
      close: vi.fn(),
    },
  });
  const client = new Client({ name: "fictional-assistant", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  cleanup.push(async () => {
    await client.close();
    await connection.close();
    rmSync(profile, { recursive: true, force: true });
  });
  return { connection, client, factory, session, state };
}

describe("advanced member MCP boundary", () => {
  it("returns opt-in fields and actionable stale/incomplete errors without logging cursors", async () => {
    const saved: unknown[] = [];
    const f = await fixture({
      save: async (value) => {
        saved.push(value);
        return true;
      },
    });
    f.state.catalog = filterCatalog();
    f.state.response = {
      success: true,
      results: [searchRow(301), searchRow(302)],
      resultCount: 3,
    };
    const input = {
      mode: "members",
      groupId: "101",
      searchTerm: "private-query",
      limit: 1,
    };
    const first = (
      await f.client.callTool({ name: "find_members", arguments: input })
    ).structuredContent as Record<string, unknown>;
    expect(first).toMatchObject({
      ok: true,
      mode: "members",
      returnedCount: 1,
      hasMore: true,
      complete: false,
    });
    expect(first).not.toHaveProperty("exactMatchUserId");
    expect(JSON.stringify(first)).not.toContain("alex@example.test");
    const continuation = first.nextContinuation;
    const selected = await f.client.callTool({
      name: "find_members",
      arguments: { ...input, fields: ["email"] },
    });
    expect(JSON.stringify(selected)).toContain("alex@example.test");
    const stale = await f.client.callTool({
      name: "find_members",
      arguments: { ...input, limit: 2, continuation },
    });
    expect(stale.structuredContent).toMatchObject({
      code: "member_search_changed",
      message: expect.stringContaining("Stop this traversal"),
    });
    const repeated = await f.client.callTool({
      name: "find_members",
      arguments: { ...input, continuation },
    });
    expect(repeated.structuredContent).toMatchObject({
      code: "member_search_incomplete",
      message: expect.stringContaining("report incomplete"),
    });
    expect(saved).toHaveLength(2);
    expect(
      JSON.stringify(saved) + JSON.stringify(stale) + JSON.stringify(repeated),
    ).not.toMatch(
      /private-query|alex@|queryKey|previousPageKey|criteriaSummary/,
    );
  });

  it("passes continuation offsets through MCP and preserves authentication failure handling", async () => {
    const f = await fixture();
    f.state.catalog = filterCatalog();
    f.state.response = {
      success: true,
      results: [searchRow()],
      resultCount: 2,
    };
    const input = { mode: "members", groupId: "101", searchTerm: "Alex" };
    const first = (
      await f.client.callTool({ name: "find_members", arguments: input })
    ).structuredContent as Record<string, unknown>;
    f.state.response = {
      success: true,
      results: [searchRow(302)],
      resultCount: 2,
    };
    const last = await f.client.callTool({
      name: "find_members",
      arguments: { ...input, continuation: first.nextContinuation },
    });
    expect(last.structuredContent).toMatchObject({
      offset: 1,
      complete: false,
      hasMore: false,
      nextContinuation: null,
      members: [{ id: "302" }],
    });
    expect(
      new URLSearchParams(
        vi.mocked(f.session.request).mock.calls.at(-1)?.[2],
      ).get("from"),
    ).toBe("1");
    f.state.response = new AuthenticationSuspectedError(
      "invalid_response",
      "unexpected_html",
      200,
    );
    f.state.verification = { success: true, userID: null, authorized: false };
    const failed = await f.client.callTool({
      name: "find_members",
      arguments: { ...input, continuation: first.nextContinuation },
    });
    expect(failed.structuredContent).toMatchObject({
      code: "authentication_required",
    });
    expect(
      vi
        .mocked(f.session.request)
        .mock.calls.filter(([p]) => p === "group/101/filter"),
    ).toHaveLength(3);
  });
});

describe("advanced count MCP boundary", () => {
  it("returns scoped criteria and totals without native rows or an identity shortcut", async () => {
    const f = await fixture();
    f.state.catalog = filterCatalog();
    const result = await f.client.callTool({
      name: "find_members",
      arguments: {
        mode: "count",
        groupId: "101",
        searchTerm: "Alex",
        criteria: {
          any: [
            {
              all: [
                {
                  fieldId: "custom:201:select:501",
                  operator: "equals",
                  value: "1",
                },
              ],
            },
          ],
        },
      },
    });
    expect(result.structuredContent).toMatchObject({
      ok: true,
      mode: "count",
      resultCount: 1,
      groupId: "101",
      includeInactive: false,
      criteriaSummary: {
        searchTerm: "Alex",
        any: [
          {
            all: [
              {
                displayName: "Volunteer preference",
                choiceLabel: "Same label",
              },
            ],
          },
        ],
      },
    });
    expect(JSON.stringify(result)).not.toMatch(
      /alex@|Rivera|555|subscribedMembers|exactMatchUserId|"members"|permissions/,
    );
    expect(vi.mocked(f.session.request).mock.calls.map((c) => c[0])).toEqual([
      "group/101/people?ajax",
      "group/101/filter",
    ]);
    const form = new URLSearchParams(
      vi.mocked(f.session.request).mock.calls[1]?.[2],
    );
    expect(form.get("request[and][1][or][0][and][0][inputs][searchTerm]")).toBe(
      "Alex",
    );
  });
  it.each([
    { mode: "count", searchTerm: "private-query", fields: ["email"] },
    { mode: "count", searchTerm: "private-query", extra: true },
    {
      searchTerm: "private-query",
      criteria: { any: [{ all: [{ fieldId: "phone", operator: "exists" }] }] },
    },
    {
      mode: "count",
      criteria: {
        any: [
          {
            all: [
              { fieldId: "phone", operator: "exists", raw: "private-query" },
            ],
          },
        ],
      },
    },
  ])(
    "rejects invalid mode/grammar without browser access: %j",
    async (args) => {
      const f = await fixture();
      const result = await f.client.callTool({
        name: "find_members",
        arguments: args,
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).not.toContain("private-query");
      expect(f.factory).not.toHaveBeenCalled();
    },
  );
  it("makes unavailable predicates actionable without dropping them", async () => {
    const f = await fixture();
    f.state.catalog = filterCatalog();
    const result = await f.client.callTool({
      name: "find_members",
      arguments: {
        mode: "count",
        groupId: "101",
        criteria: {
          any: [
            {
              all: [
                {
                  fieldId: "email_updated",
                  operator: "on",
                  value: "2026-11-04",
                },
              ],
            },
          ],
        },
      },
    });
    expect(result.structuredContent).toMatchObject({
      ok: false,
      code: "member_filter_unavailable",
      message: expect.stringContaining("Refresh member_filters"),
    });
    expect(f.session.request).toHaveBeenCalledTimes(1);
  });
  it.each(["catalog", "response"] as const)(
    "preserves transport diagnostics and does not retry a failed %s",
    async (stage) => {
      const f = await fixture();
      f.state.catalog = filterCatalog();
      f.state[stage] = new FlockbotError(
        "invalid_response",
        200,
        undefined,
        undefined,
        "response_too_large",
      );
      const result = await f.client.callTool({
        name: "find_members",
        arguments: {
          mode: "count",
          groupId: "101",
          searchTerm: "private-query",
        },
      });
      expect(result.structuredContent).toMatchObject({
        code: "invalid_response",
        diagnostic: {
          final: {
            reason: "response_too_large",
            stage: "transport",
            status: 200,
          },
        },
      });
      expect(JSON.stringify(result)).not.toMatch(/private-query|alex@|Rivera/);
      expect(f.session.request).toHaveBeenCalledTimes(
        stage === "catalog" ? 1 : 2,
      );
    },
  );
  it.each([false, true])(
    "keeps count diagnostics metadata-only unless verbose capture is explicit (%s)",
    async (verboseDiagnostics) => {
      const saved: unknown[] = [];
      const f = await fixture({
        save: async (value) => {
          saved.push(value);
          return true;
        },
      });
      f.state.catalog = filterCatalog();
      const original = vi.mocked(f.session.request).getMockImplementation()!;
      vi.mocked(f.session.request).mockImplementation(
        async (path, method, body) => {
          if (path !== "group/101/filter") return original(path, method, body);
          const data = {
            success: true,
            results: [searchRow()],
            resultCount: "invalid",
          };
          recordResponse(
            path,
            "POST",
            { status: 200, bytes: 512, contentType: "json", data },
            2,
            body,
          );
          return data;
        },
      );
      const result = await f.client.callTool({
        name: "find_members",
        arguments: {
          mode: "count",
          groupId: "101",
          verboseDiagnostics,
          criteria: {
            any: [
              {
                all: [
                  {
                    fieldId: "first_name",
                    operator: "contains",
                    value: "private-advanced-query",
                  },
                ],
              },
            ],
          },
        },
      });
      expect(result.structuredContent).toMatchObject({
        code: "invalid_response",
        diagnostic: {
          failure: {
            stage: "validation",
            reason: "invalid_result_count",
            endpoint: "group/{id}/filter",
            bytes: 512,
            status: 200,
          },
        },
      });
      expect(saved).toHaveLength(1);
      expect(JSON.stringify(result)).not.toMatch(
        /private-advanced-query|alex@|Rivera|555-0123/,
      );
      if (verboseDiagnostics) {
        expect(saved[0]).toMatchObject({
          kind: "verbose",
          exchanges: expect.any(Array),
        });
      } else {
        expect(JSON.stringify(saved)).not.toMatch(
          /private-advanced-query|alex@|Rivera|555-0123|exchanges/,
        );
      }
      expect(f.session.request).toHaveBeenCalledTimes(2);
    },
  );

  it("diagnoses an HTML filter response once without replaying the count", async () => {
    const f = await fixture();
    f.state.catalog = filterCatalog();
    f.state.response = new AuthenticationSuspectedError(
      "invalid_response",
      "unexpected_html",
      200,
    );
    f.state.verification = { success: true, userID: null, authorized: false };
    await expect(
      f.connection.findMembers({
        mode: "count",
        searchTerm: "Alex",
        groupId: "101",
      }),
    ).rejects.toMatchObject({ code: "authentication_required" });
    expect(vi.mocked(f.session.request).mock.calls.map((c) => c[0])).toEqual([
      "group/101/people?ajax",
      "group/101/filter",
      "user/userData",
    ]);
  });
});

describe("member filter MCP boundary", () => {
  it("returns only catalog choices and fails unavailable requests with refresh guidance", async () => {
    const f = await fixture();
    f.state.catalog = filterCatalog();
    const result = await f.client.callTool({
      name: "member_filters",
      arguments: { groupId: "101", fieldId: "custom:202:select:502" },
    });
    expect(result.structuredContent).toMatchObject({
      ok: true,
      groupId: "101",
      total: 2,
      choices: [
        { id: "1", label: "Same label" },
        { id: "2", label: "Same label" },
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(
      /alex@|Rivera|555|private-|permissions|subscribedMembers/,
    );
    expect(
      vi.mocked(f.session.request).mock.calls.map((c) => c.slice(0, 3)),
    ).toEqual([["group/101/people?ajax", "POST", "includeUnsubscribed=0"]]);
    const unavailable = await f.client.callTool({
      name: "member_filters",
      arguments: { groupId: "101", fieldId: "email_updated" },
    });
    expect(unavailable.structuredContent).toMatchObject({
      ok: false,
      code: "member_filter_unavailable",
      message: expect.stringContaining("Refresh member_filters"),
    });
  });
  it("returns label diagnostic reasons over MCP without reflecting metadata values", async () => {
    const f = await fixture();
    const data = filterCatalog();
    f.state.catalog = data;
    for (const [label, reason] of [
      [42, "search_filter_shape"],
      ["https://private.example.test/choice", "search_filter_label"],
    ]) {
      Object.assign(
        data.peopleFilterInfo.filters["Personal Info"].categories.ChoiceA,
        { displayName: label },
      );
      const failed = await f.client.callTool({
        name: "member_filters",
        arguments: { groupId: "101", fieldId: "custom:201:select:501" },
      });
      expect(failed.structuredContent).toMatchObject({
        ok: false,
        code: "invalid_response",
        diagnostic: { final: { reason } },
      });
      expect(JSON.stringify(failed)).not.toMatch(
        /private\.example|alex@|Rivera|subscribedMembers/,
      );
    }
  });
  it("rejects invalid selectors before I/O and preserves transport failures", async () => {
    const f = await fixture();
    const result = await f.client.callTool({
      name: "member_filters",
      arguments: { groupId: "101", groupName: "Private group" },
    });
    expect(result.structuredContent).toMatchObject({
      ok: false,
      code: "invalid_input",
    });
    expect(f.factory).not.toHaveBeenCalled();
    f.state.catalog = new FlockbotError(
      "invalid_response",
      200,
      undefined,
      undefined,
      "response_too_large",
    );
    const failed = await f.client.callTool({
      name: "member_filters",
      arguments: { groupId: "101" },
    });
    expect(failed.structuredContent).toMatchObject({
      ok: false,
      code: "invalid_response",
      diagnostic: { final: { reason: "response_too_large" } },
    });
  });
});

describe("specific-email recipient MCP boundary", () => {
  it("rejects unsupported inputs without I/O and returns only requested fields", async () => {
    const f = await fixture();
    for (const input of [
      { emailId: "../801", category: "opened" },
      { emailId: "801", category: "clicked" },
      { emailId: "801", category: "opened", page: 2 },
      { emailId: "801", category: "opened", fields: ["email"] },
      { groupId: "101", category: "opened" },
    ]) {
      expect(
        (
          await f.client.callTool({
            name: "email_recipients",
            arguments: input,
          })
        ).isError,
      ).toBe(true);
      if (input.emailId !== "../801")
        expect(
          brokerRequestSchema.safeParse({
            action: "email_recipients",
            ...input,
          }).success,
        ).toBe(false);
    }
    expect(f.factory).not.toHaveBeenCalled();
    for (const category of ["opened", "unopened"]) {
      f.state.recipients = recipientPage(category);
      const r = await f.client.callTool({
        name: "email_recipients",
        arguments: { emailId: "00801", category },
      });
      expect(r.structuredContent).toMatchObject({
        ok: true,
        requested: { emailId: "801", category },
        recipients: [{ userId: "301", firstName: "Alex" }],
        completeness: "unknown",
        hasMore: null,
      });
      expect(JSON.stringify(r)).not.toContain("alex@example.test");
    }
    expect(vi.mocked(f.session.request).mock.calls).toEqual([
      ["note/801/analyticsSummary?ajax", "GET", undefined],
      ["note/801/detailedAnalytics?ajax", "POST", "type=opened&page=1"],
      ["note/801/analyticsSummary?ajax", "GET", undefined],
      ["note/801/detailedAnalytics?ajax", "POST", "type=unopened&page=1"],
    ]);
    const r = await f.client.callTool({
      name: "email_recipients",
      arguments: { emailId: "801", category: "unopened", fields: ["address"] },
    });
    expect(r.structuredContent).toMatchObject({
      recipients: [{ address: "alex@example.test" }],
    });
    expect(
      (await f.client.listTools()).tools.find(
        (t) => t.name === "email_recipients",
      )?.annotations,
    ).toMatchObject({ readOnlyHint: true });
  });

  it("keeps permission errors private and diagnoses sign-in once without replay", async () => {
    const f = await fixture();
    f.state.recipients = new FlockbotError("permission_denied");
    expect(
      (
        await f.client.callTool({
          name: "email_recipients",
          arguments: { emailId: "801", category: "opened" },
        })
      ).structuredContent,
    ).toMatchObject({
      code: "permission_denied",
      diagnostic: { operation: "email_recipients" },
    });
    f.state.recipients = "<form>PRIVATE_LOGIN</form>";
    f.state.verification = { success: true, userID: null, authorized: false };
    const r = await f.client.callTool({
      name: "email_recipients",
      arguments: { emailId: "801", category: "opened" },
    });
    expect(r.structuredContent).toMatchObject({
      code: "authentication_required",
    });
    expect(JSON.stringify(r)).not.toContain("PRIVATE_LOGIN");
    expect(
      vi.mocked(f.session.request).mock.calls.map(([path]) => path),
    ).toEqual([
      "note/801/analyticsSummary?ajax",
      "note/801/detailedAnalytics?ajax",
      "note/801/analyticsSummary?ajax",
      "note/801/detailedAnalytics?ajax",
      "user/userData",
    ]);
    const controller = new AbortController();
    controller.abort();
    await expect(
      f.connection.emailRecipients(
        { emailId: "801", category: "opened" },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ code: "operation_cancelled" });
    expect(f.session.request).toHaveBeenCalledTimes(5);
  });
});

describe("note MCP reader", () => {
  it("validates strict inputs before I/O, then projects one read with safe annotations", async () => {
    const f = await fixture();
    for (const input of [
      { noteId: "../801" },
      { noteId: "801", save: true },
      { noteId: 801 },
      {},
    ]) {
      expect(
        (await f.client.callTool({ name: "note", arguments: input })).isError,
      ).toBe(true);
      if (input.noteId !== "../801")
        expect(
          brokerRequestSchema.safeParse({ action: "note", ...input }).success,
        ).toBe(false);
    }
    expect(f.factory).not.toHaveBeenCalled();
    const r = await f.client.callTool({
      name: "note",
      arguments: { noteId: "00801" },
    });
    expect(r.structuredContent).toMatchObject({
      ok: true,
      noteId: "801",
      completeness: "complete",
    });
    expect(JSON.stringify(r)).not.toContain("HIDDEN_");
    expect(f.session.request).toHaveBeenCalledExactlyOnceWith(
      "composer/editNote",
      "POST",
      "noteID=801&fromComposer=1",
    );
    const tools = (await f.client.listTools()).tools;
    expect(tools.find((t) => t.name === "note")?.annotations).toMatchObject({
      readOnlyHint: true,
    });
    expect(
      tools.some((t) => ["group_messages", "find_messages"].includes(t.name)),
    ).toBe(false);
  });

  it("reports validation and permission errors without replay or content in default diagnostics", async () => {
    const f = await fixture();
    f.state.note = { ...noteResponse(), noteInfo: { ID: 802 } };
    expect(
      (await f.client.callTool({ name: "note", arguments: { noteId: "801" } }))
        .structuredContent,
    ).toMatchObject({
      code: "invalid_response",
      diagnostic: {
        operation: "note",
        failure: {
          reason: "note_identity_mismatch",
        },
      },
    });
    f.state.note = new FlockbotError("permission_denied");
    expect(
      (await f.client.callTool({ name: "note", arguments: { noteId: "801" } }))
        .structuredContent,
    ).toMatchObject({ code: "permission_denied" });
    expect(
      vi.mocked(f.session.request).mock.calls.map(([path]) => path),
    ).toEqual(["composer/editNote", "composer/editNote"]);
  });

  it("diagnoses an HTML sign-in response once and never replays the note request", async () => {
    const f = await fixture();
    f.state.note = "<form>HIDDEN_LOGIN</form>";
    f.state.verification = { success: true, userID: null, authorized: false };
    await expect(f.connection.note({ noteId: "801" })).rejects.toMatchObject({
      code: "authentication_required",
    });
    expect(
      vi.mocked(f.session.request).mock.calls.map(([path]) => path),
    ).toEqual(["composer/editNote", "user/userData"]);
    const controller = new AbortController();
    controller.abort();
    await expect(
      f.connection.note({ noteId: "801" }, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: "operation_cancelled" });
    expect(f.session.request).toHaveBeenCalledTimes(2);
  });
});

describe("message search MCP/connection boundary", () => {
  it("validates before launch and returns only selected summaries without preflight or enrichment", async () => {
    const f = await fixture();
    for (const arguments_ of [
      { searchTerm: " " },
      { searchTerm: "choir", groupId: "101" },
      { searchTerm: "choir", networkID: 201 },
    ]) {
      expect(
        (
          await f.client.callTool({
            name: "find_notes",
            arguments: arguments_,
          })
        ).isError,
      ).toBe(true);
    }
    expect(f.factory).not.toHaveBeenCalled();
    const result = await f.client.callTool({
      name: "find_notes",
      arguments: { searchTerm: " choir + plans " },
    });
    expect(result.structuredContent).toMatchObject({
      ok: true,
      totalHits: 12,
      returnedCount: 3,
      omittedNonNoteCount: 1,
      notes: [
        { id: "803", type: "scheduled" },
        { id: "801", type: "email" },
        { id: "802", type: "sms" },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("HIDDEN_");
    expect(
      vi
        .mocked(f.session.request)
        .mock.calls.map(([path, method]) => [path, method]),
    ).toEqual([
      ["network/getMetadata", "POST"],
      ["supersearch/query?ajax", "POST"],
    ]);
    expect(
      (await f.client.listTools()).tools.find((t) => t.name === "find_notes")
        ?.annotations?.readOnlyHint,
    ).toBe(true);
    for (const code of ["permission_denied", "transport_failed"] as const) {
      f.state.notes = new FlockbotError(code);
      const failure = await f.client.callTool({
        name: "find_notes",
        arguments: { searchTerm: "choir + plans" },
      });
      expect(failure.structuredContent).toMatchObject({
        code,
        diagnostic: { operation: "find_notes" },
      });
      expect(failure.structuredContent).not.toHaveProperty("notes");
    }
    const before = vi.mocked(f.session.request).mock.calls.length;
    await expect(
      f.connection.findNotes(
        { searchTerm: "choir" },
        { signal: AbortSignal.abort() },
      ),
    ).rejects.toMatchObject({ code: "operation_cancelled" });
    expect(vi.mocked(f.session.request).mock.calls).toHaveLength(before);
  });

  it("runs failure-driven diagnosis once without replaying a signed-out search", async () => {
    const f = await fixture();
    f.state.notes = "<form>HIDDEN LOGIN</form>";
    f.state.verification = { success: true, userID: null, authorized: false };
    await expect(
      f.connection.findNotes({ searchTerm: "choir" }),
    ).rejects.toMatchObject({ code: "authentication_required" });
    expect(
      vi.mocked(f.session.request).mock.calls.map(([path]) => path),
    ).toEqual([
      "network/getMetadata",
      "supersearch/query?ajax",
      "user/userData",
    ]);
  });
});

describe("group message discovery MCP/connection boundary", () => {
  it.each([{ groupId: "00101" }, { groupName: " EVERYONE " }])(
    "lists one page for %j without enrichment",
    async (input) => {
      const f = await fixture();
      for (const arguments_ of [
        {},
        { groupId: "101", groupName: "Everyone" },
        { groupId: "101", offset: 50 },
      ]) {
        expect(
          (
            await f.client.callTool({
              name: "group_notes",
              arguments: arguments_,
            })
          ).isError,
        ).toBe(true);
      }
      expect(f.factory).not.toHaveBeenCalled();
      const result = await f.client.callTool({
        name: "group_notes",
        arguments: input,
      });
      expect(result.structuredContent).toMatchObject({
        ok: true,
        groupId: "101",
        returnedCount: 2,
        hasMore: true,
        notes: [
          { id: "801", type: null },
          { id: "800", type: null },
        ],
      });
      expect(
        vi
          .mocked(f.session.request)
          .mock.calls.map(([path]) => path)
          .slice(input.groupName ? 3 : 0),
      ).toEqual(["group/101/notes?ajax&more"]);
      const tools = await f.client.listTools();
      expect(
        tools.tools.find((t) => t.name === "group_notes")?.annotations
          ?.readOnlyHint,
      ).toBe(true);
      f.state.latestEmail["group/101/notes?ajax&more"] = {
        groupID: 999,
        notes: [],
        more: false,
      };
      const failed = await f.client.callTool({
        name: "group_notes",
        arguments: { groupId: "101" },
      });
      expect(failed.isError).toBe(true);
      expect(failed.structuredContent).toMatchObject({
        code: "invalid_response",
        diagnostic: { operation: "group_notes" },
      });
      expect(failed.structuredContent).not.toHaveProperty("notes");
      await expect(
        f.connection.groupNotes(
          { groupId: "101" },
          { signal: AbortSignal.abort() },
        ),
      ).rejects.toMatchObject({ code: "operation_cancelled" });
    },
  );

  it.each([false, true])(
    "diagnoses unexpected HTML without replay (signedIn=%s)",
    async (signedIn) => {
      const f = await fixture();
      f.state.latestEmail["group/101/notes?ajax&more"] =
        "<form>HIDDEN LOGIN</form>";
      f.state.verification = signedIn
        ? { success: true, userID: 201 }
        : { success: true, userID: null, authorized: false };
      await expect(
        f.connection.groupNotes({ groupId: "101" }),
      ).rejects.toMatchObject({
        code: signedIn ? "invalid_response" : "authentication_required",
      });
      expect(
        vi.mocked(f.session.request).mock.calls.map(([path]) => path),
      ).toEqual(["group/101/notes?ajax&more", "user/userData"]);
    },
  );
});

describe("aggregate email MCP/connection boundary", () => {
  it("validates before launch and returns only aggregate facts through MCP", async () => {
    const f = await fixture();
    for (const input of [
      {},
      { emailId: "../801" },
      { emailId: "801", groupId: "101" },
      { groupId: "101", groupName: "Everyone" },
      { groupName: " " },
      { groupId: "101", userId: "301" },
    ]) {
      const result = await f.client.callTool({
        name: "email_analytics",
        arguments: input,
      });
      expect(result.isError).toBe(true);
    }
    await expect(
      f.connection.emailAnalytics(
        { emailId: "801" },
        { signal: AbortSignal.abort() },
      ),
    ).rejects.toMatchObject({ code: "operation_cancelled" });
    expect(f.factory).not.toHaveBeenCalled();
    const result = await f.client.callTool({
      name: "email_analytics",
      arguments: { emailId: "801" },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      selection: "selected",
      email: { id: "801" },
      counts: { opened: 17, unopened: 9, complaint: 0 },
    });
    expect(
      vi.mocked(f.session.request).mock.calls.map(([path]) => path),
    ).toEqual(["note/801/analyticsSummary?ajax"]);
    expect(
      (await f.client.listTools()).tools.find(
        (t) => t.name === "email_analytics",
      )?.annotations?.readOnlyHint,
    ).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(
      /PRIVATE|Rivera|alex@|noteTargets/,
    );
    f.state.latestEmail["note/801/analyticsSummary?ajax"] = new Error(
      "private@example.test",
    );
    const failed = await f.client.callTool({
      name: "email_analytics",
      arguments: { emailId: "801" },
    });
    expect(failed.isError).toBe(true);
    expect(failed.structuredContent).not.toHaveProperty("counts");
    expect(JSON.stringify(failed)).not.toContain("private@");
  });

  it.each([{ groupId: "00101" }, { groupName: " EVERYONE " }])(
    "routes group selection %j through MCP without recipient reads",
    async (input) => {
      const f = await fixture();
      const result = await f.client.callTool({
        name: "email_analytics",
        arguments: input,
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        groupId: "101",
        email: { id: "801" },
        counts: { opened: 17, total: 31 },
        reason: null,
      });
      const paths = vi
        .mocked(f.session.request)
        .mock.calls.map(([path]) => path);
      expect(paths.slice(input.groupName ? 3 : 0)).toEqual([
        "group/101/notes?ajax&more",
        "note/801/analyticsSummary?ajax",
        "note/801/analytics2?ajax",
      ]);
      if (input.groupName)
        expect(paths.slice(0, 3).sort()).toEqual([
          "dashboard",
          "navigation/groups",
          "network/getMetadata",
        ]);
      expect(JSON.stringify(result)).not.toMatch(
        /PRIVATE|Rivera|alex@|summaryCounts|noteTargets/,
      );
    },
  );

  it.each([false, true])(
    "rejects missing/ambiguous group names before analytics (ambiguous=%s)",
    async (ambiguous) => {
      const f = await fixture();
      if (ambiguous)
        f.state.navigation = {
          groups: [
            { ID: 102, name: "Choir", shortname: "choir-a" },
            { ID: 103, name: "CHOIR", shortname: "choir-b" },
          ],
        };
      await expect(
        f.connection.emailAnalytics({ groupName: "choir" }),
      ).rejects.toMatchObject({
        code: ambiguous ? "group_ambiguous" : "group_not_found",
      });
      expect(
        vi
          .mocked(f.session.request)
          .mock.calls.map(([path]) => path)
          .sort(),
      ).toEqual(["dashboard", "navigation/groups", "network/getMetadata"]);
    },
  );

  it.each([false, true])(
    "diagnoses unexpected listing HTML once (signedIn=%s)",
    async (signedIn) => {
      const f = await fixture();
      f.state.latestEmail["group/101/notes?ajax&more"] =
        "<form>PRIVATE LOGIN</form>";
      f.state.verification = signedIn
        ? { success: true, userID: 201 }
        : { success: true, userID: null, authorized: false };
      await expect(
        f.connection.emailAnalytics({ groupId: "101" }),
      ).rejects.toMatchObject({
        code: signedIn ? "invalid_response" : "authentication_required",
      });
      expect(await f.connection.status()).toMatchObject({
        state: signedIn ? "ready" : "action_required",
      });
      expect(
        vi.mocked(f.session.request).mock.calls.map(([path]) => path),
      ).toEqual(["group/101/notes?ajax&more", "user/userData"]);
    },
  );

  it("rejects wrong-group JSON without diagnosis and cancels before summary reads", async () => {
    const f = await fixture();
    f.state.latestEmail["group/101/notes?ajax&more"] = {
      ...latestEmailResponses()["group/101/notes?ajax&more"],
      groupID: 999,
    };
    await expect(
      f.connection.emailAnalytics({ groupId: "101" }),
    ).rejects.toMatchObject({
      code: "invalid_response",
      reason: "group_identity_mismatch",
    });
    expect(
      vi.mocked(f.session.request).mock.calls.map(([path]) => path),
    ).toEqual(["group/101/notes?ajax&more"]);
    const controller = new AbortController();
    vi.mocked(f.session.request)
      .mockClear()
      .mockImplementationOnce(async () => {
        controller.abort();
        return latestEmailResponses()["group/101/notes?ajax&more"];
      });
    await expect(
      f.connection.emailAnalytics(
        { groupId: "101" },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ code: "operation_cancelled" });
    expect(
      vi.mocked(f.session.request).mock.calls.map(([path]) => path),
    ).toEqual(["group/101/notes?ajax&more"]);
  });

  it.each([false, true])(
    "diagnoses summary login HTML with signedIn=%s without replay",
    async (signedIn) => {
      const f = await fixture();
      f.state.latestEmail["note/801/analyticsSummary?ajax"] =
        "<form>PRIVATE LOGIN</form>";
      f.state.verification = signedIn
        ? { success: true, userID: 201 }
        : { success: true, userID: null, authorized: false };
      await expect(
        f.connection.emailAnalytics({ emailId: "801" }),
      ).rejects.toMatchObject({
        code: signedIn ? "invalid_response" : "authentication_required",
      });
      expect(await f.connection.status()).toMatchObject({
        state: signedIn ? "ready" : "action_required",
      });
      expect(
        vi.mocked(f.session.request).mock.calls.map(([path]) => path),
      ).toEqual(["note/801/analyticsSummary?ajax", "user/userData"]);
    },
  );
});

describe("latest email MCP/connection boundary", () => {
  it("resolves a named group and returns only the requested member's engagement", async () => {
    const f = await fixture();
    const result = await f.client.callTool({
      name: "member_latest_email_status",
      arguments: { userId: "301", groupName: " EVERYONE " },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: true,
      selection: "selected",
      email: { id: "801" },
      engagement: "recorded_open",
      reason: null,
    });
    expect(JSON.stringify(result)).not.toMatch(
      /alex@|other@|PRIVATE|Rivera|userInfo/,
    );
    expect(
      (await f.client.listTools()).tools.find(
        (t) => t.name === "member_latest_email_status",
      )?.annotations?.readOnlyHint,
    ).toBe(true);
    expect(f.session.request).not.toHaveBeenCalledWith("user/userData");
    f.state.latestEmail["note/801/searchAnalytics?ajax"] = new Error(
      "private@example.test",
    );
    const failed = await f.client.callTool({
      name: "member_latest_email_status",
      arguments: { userId: "301", groupId: "101" },
    });
    expect(failed.isError).toBe(true);
    expect(failed.structuredContent).not.toHaveProperty("engagement");
    expect(JSON.stringify(failed)).not.toContain("private@");
  });

  it.each([
    {
      signedIn: false,
      code: "authentication_required",
      state: "action_required",
    },
    { signedIn: true, code: "invalid_response", state: "ready" },
  ])(
    "diagnoses unexpected listing HTML with signedIn=$signedIn without replay",
    async ({ signedIn, code, state }) => {
      const f = await fixture();
      f.state.latestEmail["group/101/notes?ajax&more"] =
        "<html><body>Sign in</body></html>";
      f.state.verification = signedIn
        ? { success: true, userID: 201 }
        : { success: true, userID: null, authorized: false };
      await expect(
        f.connection.memberLatestEmailStatus({ userId: "301", groupId: "101" }),
      ).rejects.toMatchObject({ code });
      expect(await f.connection.status()).toMatchObject({ state });
      expect(
        vi.mocked(f.session.request).mock.calls.map(([path]) => path),
      ).toEqual(["group/101/notes?ajax&more", "user/userData"]);
    },
  );

  it("rejects a different group without diagnosing the session", async () => {
    const f = await fixture();
    f.state.latestEmail["group/101/notes?ajax&more"] = {
      ...latestEmailResponses()["group/101/notes?ajax&more"],
      groupID: 102,
    };
    await expect(
      f.connection.memberLatestEmailStatus({ userId: "301", groupId: "101" }),
    ).rejects.toMatchObject({ code: "invalid_response" });
    expect(await f.connection.status()).toMatchObject({ state: "ready" });
    expect(
      vi.mocked(f.session.request).mock.calls.map(([path]) => path),
    ).toEqual(["group/101/notes?ajax&more"]);
  });

  it("validates before browser access and cancels between notes and analytics", async () => {
    const f = await fixture();
    for (const input of [
      { userId: "301" },
      { userId: "301", groupId: "101", groupName: "Everyone" },
      { userId: "../301", groupId: "101" },
    ])
      await expect(
        f.connection.memberLatestEmailStatus(input),
      ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      f.connection.memberLatestEmailStatus(
        { userId: "301", groupId: "101" },
        { signal: AbortSignal.abort() },
      ),
    ).rejects.toMatchObject({ code: "operation_cancelled" });
    expect(f.factory).not.toHaveBeenCalled();
    expect(
      brokerRequestSchema.safeParse({
        action: "member_latest_email_status",
        userId: "301",
        groupId: "101",
        url: "https://example.test",
      }).success,
    ).toBe(false);
    let finish = (_value: unknown) => {};
    f.state.latestEmail["group/101/notes?ajax&more"] = new Promise(
      (resolve) => {
        finish = resolve;
      },
    );
    const controller = new AbortController();
    const pending = f.connection.memberLatestEmailStatus(
      { userId: "301", groupId: "101" },
      { signal: controller.signal },
    );
    const rejected = expect(pending).rejects.toMatchObject({
      code: "operation_cancelled",
    });
    try {
      await waitFor(() => expect(f.session.request).toHaveBeenCalledTimes(1));
      controller.abort();
      await rejected;
    } finally {
      finish(latestEmailResponses()["group/101/notes?ajax&more"]);
    }
    await f.connection.close();
    expect(f.session.request).toHaveBeenCalledTimes(1);
  });
});

describe("membership MCP/connection boundary", () => {
  it("performs search, selected contact lookup, subscriptions and one-group check through real MCP", async () => {
    const f = await fixture();
    const found = await f.client.callTool({
      name: "find_members",
      arguments: { searchTerm: "Alex Rivera", groupId: "101" },
    });
    expect(found.structuredContent).toMatchObject({
      ok: true,
      exactMatchUserId: "301",
      complete: true,
    });
    expect(JSON.stringify(found)).not.toContain("alex@");
    const foundBody = found.structuredContent as Record<string, unknown>;
    const userId = String(foundBody.exactMatchUserId);
    const person = await f.client.callTool({
      name: "member",
      arguments: { userId, fields: ["email"] },
    });
    expect(person.structuredContent).toMatchObject({
      ok: true,
      member: {
        id: userId,
        email: {
          value: "alex@example.test",
          verified: false,
          isBadEmail: true,
        },
      },
    });
    const groups = await f.client.callTool({
      name: "member_groups",
      arguments: { userId },
    });
    expect(groups.structuredContent).toMatchObject({
      ok: true,
      userId,
      groups: [
        { id: "101", name: "Everyone" },
        { id: "102", name: "Choir" },
      ],
      observedCount: 2,
      returnedCount: 2,
      truncated: false,
      complete: false,
    });
    const checked = await f.client.callTool({
      name: "is_member",
      arguments: { userId, groupId: "102" },
    });
    expect(checked.structuredContent).toMatchObject({
      ok: true,
      userId,
      groupId: "102",
      groupName: "Choir",
      membership: "member",
      update: { availableVersion: "0.3.0" },
    });
    expect(f.session.request).toHaveBeenCalledTimes(5);
    const tools = await f.client.listTools();
    for (const name of ["member_groups", "is_member"])
      expect(
        tools.tools.find((t) => t.name === name)?.annotations?.readOnlyHint,
      ).toBe(true);
    expect(f.client.getInstructions()).toContain("Missing groups mean unknown");
  });

  it("resolves a unique group name in the same call and distinguishes explicit false from absence", async () => {
    const f = await fixture();
    f.state.navigation = {
      groups: [{ ID: 102, name: "Choir", shortname: "choir" }],
    };
    const named = await f.client.callTool({
      name: "is_member",
      arguments: { userId: "301", groupName: " CHOIR " },
    });
    expect(named.structuredContent).toMatchObject({
      groupId: "102",
      membership: "member",
    });
    for (const [groupId, membership] of [
      ["103", "not_member"],
      ["104", "unknown"],
    ]) {
      const value = await f.client.callTool({
        name: "is_member",
        arguments: { userId: "301", groupId },
      });
      expect(value.structuredContent).toMatchObject({
        ok: true,
        userId: "301",
        groupId,
        membership,
      });
    }
    expect(f.session.request).not.toHaveBeenCalledWith("user/userData");
  });

  it("rejects invalid inputs before opening a browser and restricts IPC operations", async () => {
    const f = await fixture();
    await expect(f.connection.memberGroups("../301")).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(f.connection.isMember("301", {})).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(
      f.connection.isMember("301", { groupId: "102", groupName: "Choir" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(f.factory).not.toHaveBeenCalled();
    expect(
      brokerRequestSchema.safeParse({ action: "member_groups", userId: "301" })
        .success,
    ).toBe(true);
    expect(
      brokerRequestSchema.safeParse({
        action: "is_member",
        userId: "301",
        groupName: "Choir",
      }).success,
    ).toBe(true);
    for (const input of [
      { action: "member_groups", userId: "301", fields: ["email"] },
      { action: "is_member", userId: "301", path: "arbitrary" },
    ])
      expect(brokerRequestSchema.safeParse(input).success).toBe(false);
  });

  it("keeps denied, malformed and transport errors distinct from negative membership", async () => {
    const f = await fixture();
    for (const response of [
      { success: true, data: { canView: false, subscribedGroups: [] } },
      {
        success: true,
        data: {
          canView: true,
          subscribedGroups: [
            { groupID: 102, groupName: "Choir", isSubscribed: "false" },
          ],
        },
      },
      { success: false, error: "private@example.test" },
      new Error("private@example.test"),
    ]) {
      f.state.memberships = response;
      const result = await f.client.callTool({
        name: "is_member",
        arguments: { userId: "301", groupId: "102" },
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).not.toHaveProperty("membership");
      expect(JSON.stringify(result)).not.toContain("private@");
    }
    expect(f.session.request).toHaveBeenCalledTimes(4);
    expect(await f.connection.status()).toMatchObject({ state: "ready" });
  });

  it("diagnoses explicit expiry once and never replays the membership POST", async () => {
    const f = await fixture();
    f.state.memberships = { success: false, authorized: false };
    f.state.verification = { success: true, userID: null, authorized: false };
    await expect(
      f.connection.isMember("301", { groupId: "102" }),
    ).rejects.toMatchObject({ code: "authentication_required" });
    expect(f.session.request).toHaveBeenCalledTimes(2);
    expect(f.session.request).toHaveBeenLastCalledWith("user/userData");
    expect(await f.connection.status()).toMatchObject({
      state: "action_required",
    });
  });

  it("cancels before browser access and interrupts in-flight membership work without replay", async () => {
    const f = await fixture();
    await expect(
      f.connection.memberGroups("301", { signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ code: "operation_cancelled" });
    expect(f.factory).not.toHaveBeenCalled();
    let finish = (_value: unknown) => {};
    f.state.memberships = new Promise((resolve) => {
      finish = resolve;
    });
    const controller = new AbortController();
    const pending = f.connection.isMember(
      "301",
      { groupId: "102" },
      { signal: controller.signal },
    );
    const rejected = expect(pending).rejects.toMatchObject({
      code: "operation_cancelled",
    });
    try {
      await waitFor(() => expect(f.session.request).toHaveBeenCalledTimes(1));
      controller.abort();
      await rejected;
      expect(f.session.request).toHaveBeenCalledTimes(1);
    } finally {
      finish(membershipResponse());
    }
  });
});

describe("communication diagnostics MCP/connection boundary", () => {
  it("resolves a group and returns diagnostic facts without default contact disclosure", async () => {
    const f = await fixture();
    f.state.navigation = {
      groups: [{ ID: 102, name: "Choir", shortname: "choir" }],
    };
    const result = await f.client.callTool({
      name: "member_communication_status",
      arguments: { userId: "301", groupName: " CHOIR " },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: true,
      userId: "301",
      groupId: "102",
      membership: "member",
      email: {
        preference: "enabled",
        contactPresent: true,
        verified: false,
        isBadEmail: true,
      },
      sms: {
        preference: "disabled",
        contactPresent: true,
        verified: true,
        stopReplied: null,
      },
    });
    expect(JSON.stringify(result)).not.toMatch(
      /alex@|555|pendingEmail|userInfo/,
    );
    const selected = await f.client.callTool({
      name: "member_communication_status",
      arguments: { userId: "301", groupId: "102", fields: ["mobilePhone"] },
    });
    expect(selected.structuredContent).toMatchObject({
      sms: { value: "+1 (202) 555-0123" },
    });
    expect(JSON.stringify(selected)).not.toContain("alex@");
    expect(f.session.request).not.toHaveBeenCalledWith("user/userData");
    expect(
      (await f.client.listTools()).tools.find(
        (t) => t.name === "member_communication_status",
      )?.annotations?.readOnlyHint,
    ).toBe(true);
  });

  it("rejects invalid selectors and fields before starting the browser", async () => {
    const f = await fixture();
    for (const input of [
      { userId: "301" },
      { userId: "301", groupId: "102", groupName: "Choir" },
      { userId: "../301", groupId: "102" },
      { userId: "301", groupId: "102", fields: ["email", "email"] as const },
    ])
      await expect(
        f.connection.memberCommunicationStatus(input),
      ).rejects.toMatchObject({ code: "invalid_input" });
    expect(f.factory).not.toHaveBeenCalled();
    expect(
      brokerRequestSchema.safeParse({
        action: "member_communication_status",
        userId: "301",
        groupId: "102",
        url: "https://example.test",
      }).success,
    ).toBe(false);
  });

  it("returns sanitized errors rather than partial diagnostics when either read fails", async () => {
    const f = await fixture();
    for (const target of ["memberships", "profile"] as const) {
      for (const bad of [
        { success: true, canViewProfile: false, data: { canView: false } },
        { success: true },
        new Error("private@example.test"),
      ]) {
        f.state.memberships = membershipResponse();
        f.state.profile = profileResponse();
        f.state[target] = bad;
        const result = await f.client.callTool({
          name: "member_communication_status",
          arguments: { userId: "301", groupId: "102" },
        });
        expect(result.isError).toBe(true);
        expect(result.structuredContent).not.toHaveProperty("membership");
        expect(result.structuredContent).not.toHaveProperty("email");
        expect(JSON.stringify(result)).not.toContain("private@");
      }
    }
    // Three failures before the profile, then three failures after one groups read.
    expect(f.session.request).toHaveBeenCalledTimes(9);
  });

  it("cancels between reads without fetching a profile or replaying", async () => {
    const f = await fixture();
    await expect(
      f.connection.memberCommunicationStatus(
        { userId: "301", groupId: "102" },
        { signal: AbortSignal.abort() },
      ),
    ).rejects.toMatchObject({ code: "operation_cancelled" });
    expect(f.factory).not.toHaveBeenCalled();
    let finish = (_value: unknown) => {};
    f.state.memberships = new Promise((resolve) => {
      finish = resolve;
    });
    const controller = new AbortController();
    const pending = f.connection.memberCommunicationStatus(
      { userId: "301", groupId: "102" },
      { signal: controller.signal },
    );
    const rejected = expect(pending).rejects.toMatchObject({
      code: "operation_cancelled",
    });
    try {
      await waitFor(() => expect(f.session.request).toHaveBeenCalledTimes(1));
      controller.abort();
      await rejected;
    } finally {
      finish(membershipResponse());
    }
    await f.connection.close();
    expect(f.session.request).toHaveBeenCalledTimes(1);
  });
});

describe("identified profile MCP/connection boundary", () => {
  it("returns identity by default and only explicitly selected contact details", async () => {
    const f = await fixture();
    const identity = await f.client.callTool({
      name: "member",
      arguments: { userId: "301" },
    });
    expect(identity.structuredContent).toMatchObject({
      ok: true,
      member: { id: "301", firstName: "Alex", lastName: "Rivera" },
    });
    expect(JSON.stringify(identity)).not.toMatch(/alex@|555|canEdit|pending/);
    const selected = await f.client.callTool({
      name: "member",
      arguments: { userId: "301", fields: ["email"] },
    });
    expect(selected.structuredContent).toMatchObject({
      ok: true,
      member: {
        email: {
          value: "alex@example.test",
          verified: false,
          isBadEmail: true,
        },
      },
      update: { availableVersion: "0.3.0" },
    });
    expect(JSON.stringify(selected)).not.toMatch(/555|canEdit|pending/);
    expect(f.session.request).toHaveBeenCalledTimes(2);
    expect(f.session.request).toHaveBeenNthCalledWith(
      1,
      "user/301/profile",
      "POST",
      undefined,
    );
    expect(f.session.request).toHaveBeenNthCalledWith(
      2,
      "user/301/profile",
      "POST",
      undefined,
    );
    const tools = await f.client.listTools();
    expect(
      tools.tools.find((t) => t.name === "member")?.annotations?.readOnlyHint,
    ).toBe(true);
  });

  it("rejects malformed direct arguments before browser access and validates typed IPC", async () => {
    const f = await fixture();
    await expect(
      f.connection.member("../301", ["email"]),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      f.connection.member("301", ["email", "email"]),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(f.factory).not.toHaveBeenCalled();
    expect(
      brokerRequestSchema.safeParse({
        action: "member",
        userId: "301",
        fields: ["email"],
      }).success,
    ).toBe(true);
    for (const input of [
      { action: "member", userId: "301", fields: ["medical"] },
      { action: "member", userId: "301", path: "arbitrary" },
      { action: "member", userId: "301", fields: ["email", "email", "email"] },
    ])
      expect(brokerRequestSchema.safeParse(input).success).toBe(false);
  });

  it("does not probe authentication or replay a restricted member read", async () => {
    const f = await fixture();
    f.state.profile = { ...profileResponse(), canViewProfile: false };
    const result = await f.client.callTool({
      name: "member",
      arguments: { userId: "301", fields: ["email"] },
    });
    expect(result.structuredContent).toMatchObject({
      ok: false,
      code: "permission_denied",
    });
    expect(JSON.stringify(result)).not.toContain("alex@");
    expect(f.session.request).toHaveBeenCalledTimes(1);
    expect(await f.connection.status()).toMatchObject({ state: "ready" });
  });

  it("keeps business rejection and unexpected errors sanitized without replay", async () => {
    const f = await fixture();
    for (const failure of [
      { success: false, error: "private@example.test" },
      new Error("private@example.test"),
    ]) {
      f.state.profile = failure;
      const result = await f.client.callTool({
        name: "member",
        arguments: { userId: "301", fields: ["email"] },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).not.toContain("private@");
    }
    expect(f.session.request).toHaveBeenCalledTimes(2);
    expect(await f.connection.status()).toMatchObject({ state: "ready" });
  });

  it("diagnoses explicit expiry once without repeating the failed profile read", async () => {
    const f = await fixture();
    f.state.profile = { success: false, authorized: false };
    f.state.verification = { success: true, userID: null, authorized: false };
    await expect(f.connection.member("301", ["email"])).rejects.toMatchObject({
      code: "authentication_required",
    });
    expect(f.session.request).toHaveBeenCalledTimes(2);
    expect(f.session.request).toHaveBeenLastCalledWith("user/userData");
    expect(await f.connection.status()).toMatchObject({
      state: "action_required",
    });
  });

  it("cancels queued and in-flight reads without starting a second profile request", async () => {
    const f = await fixture();
    await expect(
      f.connection.member("301", [], { signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ code: "operation_cancelled" });
    expect(f.factory).not.toHaveBeenCalled();
    let finish = (_value: unknown) => {};
    f.state.profile = new Promise((resolve) => {
      finish = resolve;
    });
    const controller = new AbortController();
    const pending = f.connection.member("301", ["email"], {
      signal: controller.signal,
    });
    const rejected = expect(pending).rejects.toMatchObject({
      code: "operation_cancelled",
    });
    try {
      await waitFor(() => expect(f.session.request).toHaveBeenCalledTimes(1));
      controller.abort();
      await rejected;
      expect(f.session.request).toHaveBeenCalledTimes(1);
    } finally {
      finish(profileResponse());
    }
  });
});

describe("member search MCP/connection boundary", () => {
  it("reads a group subscription date by a uniquely matching selected email", async () => {
    const f = await fixture();
    const result = await f.client.callTool({
      name: "find_members",
      arguments: {
        searchTerm: "alex@example.test",
        groupId: "101",
        fields: ["email", "joinedOn"],
      },
    });
    expect(result.structuredContent).toMatchObject({
      ok: true,
      groupId: "101",
      exactMatchUserId: "301",
      members: [{ id: "301", joinedOn: "2026-03-05" }],
    });
    expect(JSON.stringify(result)).not.toContain("555");
    expect(f.client.getInstructions()).toContain("within that requested group");
    expect(f.client.getInstructions()).toContain("no precise time, timezone");
    expect(
      brokerRequestSchema.safeParse({
        action: "find_members",
        searchTerm: "alex@example.test",
        groupId: "101",
        fields: ["email", "mobilePhone", "joinedOn"],
      }).success,
    ).toBe(true);
    // Profile contact selection remains separate from group subscription dates.
    expect(
      brokerRequestSchema.safeParse({
        action: "member",
        userId: "301",
        fields: ["joinedOn"],
      }).success,
    ).toBe(false);
  });

  it("supports resolving same-name records by contacts while retaining IDs for internal follow-up", async () => {
    const f = await fixture();
    f.state.response = {
      success: true,
      resultCount: 3,
      results: [
        { ...searchRow(), mail: "alex.work@example.test" },
        { ...searchRow(302), mail: "alex.home@example.test" },
        { ...searchRow(303), mail: null, phn: "+1 (202) 555-0198" },
      ],
    };
    const identities = await f.client.callTool({
      name: "find_members",
      arguments: { searchTerm: "Alex Rivera", groupId: "101" },
    });
    expect(identities.structuredContent).not.toHaveProperty("exactMatchUserId");
    expect(JSON.stringify(identities)).not.toContain("@example.test");

    const contacts = await f.client.callTool({
      name: "find_members",
      arguments: {
        searchTerm: "Alex Rivera",
        groupId: "101",
        fields: ["email"],
      },
    });
    expect(contacts.structuredContent).toMatchObject({
      complete: true,
      members: [
        { id: "301", email: { value: "alex.work@example.test" } },
        { id: "302", email: { value: "alex.home@example.test" } },
        { id: "303", email: { value: null } },
      ],
    });
    expect(contacts.structuredContent).not.toHaveProperty("exactMatchUserId");
    expect(JSON.stringify(contacts)).not.toContain("555");

    const phones = await f.client.callTool({
      name: "find_members",
      arguments: {
        searchTerm: "Alex Rivera",
        groupId: "101",
        fields: ["mobilePhone"],
      },
    });
    expect(phones.structuredContent).toMatchObject({
      members: [
        { id: "301", mobilePhone: { value: "+1 (202) 555-0123" } },
        { id: "302", mobilePhone: { value: "+1 (202) 555-0123" } },
        { id: "303", mobilePhone: { value: "+1 (202) 555-0198" } },
      ],
    });
    expect(JSON.stringify(phones)).not.toContain("@example.test");

    // The assistant maps the user's chosen email back to the internal key.
    const body = contacts.structuredContent as {
      members: { id: string; email: { value: string | null } }[];
    };
    const chosen = body.members.find(
      (person) => person.email.value === "alex.work@example.test",
    );
    expect(chosen).toBeDefined();
    expect(
      (
        await f.client.callTool({
          name: "member_groups",
          arguments: { userId: chosen?.id },
        })
      ).structuredContent,
    ).toMatchObject({
      ok: true,
      groups: [{ name: "Everyone" }, { name: "Choir" }],
    });

    const instructions = f.client.getInstructions();
    expect(instructions).toContain("Member IDs are internal");
    expect(instructions).toContain("Before asking which person");
    expect(instructions).toContain("email is missing or does not distinguish");
    expect(instructions).toContain(
      "do not invent differences or guess a record",
    );
    const { tools } = await f.client.listTools();
    expect(
      tools.find((tool) => tool.name === "find_members")?.description,
    ).toContain("clarify ambiguous names using selected contacts");
  });

  it("asks for an explicit group when Everyone is unavailable", async () => {
    const f = await fixture();
    f.state.everyoneGroupID = null;
    const result = await f.client.callTool({
      name: "find_members",
      arguments: { searchTerm: "Alex Rivera" },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      code: "everyone_not_found",
      message: expect.stringContaining("explicit groupId or groupName"),
    });
    expect(f.session.request).not.toHaveBeenCalledWith(
      expect.stringContaining("/filter"),
      expect.anything(),
      expect.anything(),
    );
  });

  it("dispatches real MCP search with selected fields, scoped identity and optional updates", async () => {
    const f = await fixture();
    const result = await f.client.callTool({
      name: "find_members",
      arguments: {
        searchTerm: "Alex Rivera",
        groupId: "101",
        fields: ["email"],
      },
    });
    expect(result.structuredContent).toMatchObject({
      ok: true,
      groupId: "101",
      resultCount: 1,
      complete: true,
      exactMatchUserId: "301",
      members: [
        { id: "301", email: { value: "alex@example.test", verified: false } },
      ],
      update: { availableVersion: "0.3.0" },
    });
    expect(JSON.stringify(result)).not.toMatch(/555|mailVer|userActive/);
    expect(f.session.request).toHaveBeenCalledTimes(2);
    expect(f.session.request).toHaveBeenNthCalledWith(
      1,
      "group/101/people?ajax",
      "POST",
      "includeUnsubscribed=0",
    );
    expect(f.session.request).toHaveBeenNthCalledWith(
      2,
      "group/101/filter",
      "POST",
      expect.any(String),
    );
    expect(f.client.getInstructions()).toContain("exactMatchUserId");
    const tools = await f.client.listTools();
    expect(
      tools.tools.find((t) => t.name === "find_members")?.annotations
        ?.readOnlyHint,
    ).toBe(true);
  });

  it("rejects invalid direct inputs before opening a browser and validates IPC request shape", async () => {
    const f = await fixture();
    await expect(
      f.connection.findMembers({
        searchTerm: "Alex",
        groupId: "101",
        groupName: "Choir",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(f.factory).not.toHaveBeenCalled();
    expect(
      brokerRequestSchema.safeParse({
        action: "find_members",
        searchTerm: "Alex",
        groupId: "101",
        fields: ["email"],
        limit: 50,
      }).success,
    ).toBe(true);
    for (const invalid of [
      { action: "find_members", searchTerm: "Alex", path: "arbitrary" },
      { action: "find_members", searchTerm: "Alex", fields: ["password"] },
      { action: "find_members", searchTerm: "Alex", limit: 51 },
    ])
      expect(brokerRequestSchema.safeParse(invalid).success).toBe(false);
    const oversizedLegacy = brokerRequestSchema.safeParse({
      action: "find_members",
      searchTerm: "Alex",
      limit: 51,
    });
    expect(oversizedLegacy.error?.issues).toEqual([
      expect.objectContaining({
        path: ["limit"],
        message: "Limits above 50 require mode members.",
      }),
    ]);
  });

  it("does not replay a business rejection, leak upstream contacts or perform an auth probe", async () => {
    const f = await fixture();
    f.state.response = { success: false, error: "private@example.test" };
    const result = await f.client.callTool({
      name: "find_members",
      arguments: { searchTerm: "Alex", groupId: "101" },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: false,
      code: "upstream_rejected",
    });
    expect(JSON.stringify(result)).not.toContain("private@");
    expect(f.session.request).toHaveBeenCalledTimes(2);
    expect(await f.connection.status()).toMatchObject({ state: "ready" });
  });

  it("diagnoses explicit authentication failure once and never repeats the failed search", async () => {
    const f = await fixture();
    f.state.response = { success: false, authorized: false };
    f.state.verification = { success: true, userID: null, authorized: false };
    await expect(
      f.connection.findMembers({ searchTerm: "Alex", groupId: "101" }),
    ).rejects.toMatchObject({ code: "authentication_required" });
    expect(f.session.request).toHaveBeenCalledTimes(3);
    expect(f.session.request).toHaveBeenLastCalledWith("user/userData");
    expect(await f.connection.status()).toMatchObject({
      state: "action_required",
    });
  });

  it("rejects cancelled work before browser access", async () => {
    const f = await fixture();
    await expect(
      f.connection.findMembers(
        { searchTerm: "Alex", groupId: "101" },
        { signal: AbortSignal.abort() },
      ),
    ).rejects.toMatchObject({ code: "operation_cancelled" });
    expect(f.factory).not.toHaveBeenCalled();
  });
});
