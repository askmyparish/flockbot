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

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

async function fixture() {
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
    response: unknown;
    verification: unknown;
    everyoneGroupID: number | null;
  } = {
    response: { success: true, results: [searchRow()], resultCount: 1 },
    verification: { success: true, userID: 201 },
    everyoneGroupID: 101,
  };
  const session: BrowserSession = {
    signIn: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    request: vi.fn(async (path) => {
      if (path === "user/userData") return state.verification;
      if (path === "dashboard") return '<div id="fnReactHolder"></div>';
      if (path === "navigation/groups") return { groups: [] };
      if (path === "network/getMetadata")
        return { everyoneGroupID: state.everyoneGroupID };
      if (path === "group/101/people?ajax") return searchMetadata();
      if (path === "group/101/filter") {
        if (state.response instanceof Error) throw state.response;
        return state.response;
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

describe("member search MCP/connection boundary", () => {
  it("asks for an explicit group when Everyone is unavailable", async () => {
    const f = await fixture();
    f.state.everyoneGroupID = null;
    const result = await f.client.callTool({
      name: "flocknote_find_members",
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
      name: "flocknote_find_members",
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
      tools.tools.find((t) => t.name === "flocknote_find_members")?.annotations
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
  });

  it("does not replay a business rejection, leak upstream contacts or perform an auth probe", async () => {
    const f = await fixture();
    f.state.response = { success: false, error: "private@example.test" };
    const result = await f.client.callTool({
      name: "flocknote_find_members",
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
