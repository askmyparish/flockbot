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
import { profileResponse } from "../fixtures/member-profile.js";
import { waitFor } from "./support.js";

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
    profile: unknown;
  } = {
    response: { success: true, results: [searchRow()], resultCount: 1 },
    verification: { success: true, userID: 201 },
    everyoneGroupID: 101,
    profile: profileResponse(),
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
      if (path === "user/301/profile") {
        if (state.profile instanceof Error) throw state.profile;
        return state.profile;
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

describe("identified profile MCP/connection boundary", () => {
  it("returns identity by default and only explicitly selected contact details", async () => {
    const f = await fixture();
    const identity = await f.client.callTool({
      name: "flocknote_member",
      arguments: { userId: "301" },
    });
    expect(identity.structuredContent).toMatchObject({
      ok: true,
      member: { id: "301", firstName: "Alex", lastName: "Rivera" },
    });
    expect(JSON.stringify(identity)).not.toMatch(/alex@|555|canEdit|pending/);
    const selected = await f.client.callTool({
      name: "flocknote_member",
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
      tools.tools.find((t) => t.name === "flocknote_member")?.annotations
        ?.readOnlyHint,
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
      name: "flocknote_member",
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
        name: "flocknote_member",
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
