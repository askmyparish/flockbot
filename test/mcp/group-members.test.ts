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
import type { GroupMembersResult } from "../../src/models/group-members.js";
import { rosterPage, rosterRow } from "../fixtures/group-members.js";
import { waitFor } from "./support.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

async function fixture() {
  const profile = mkdtempSync(join(tmpdir(), "flockbot-group-members-"));
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
  const state: { verification: unknown; pages: Map<string, unknown> } = {
    verification: { success: true, userID: 201 },
    pages: new Map([["group/102/people?ajax", rosterPage()]]),
  };
  const session: BrowserSession = {
    signIn: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    request: vi.fn(async (path) => {
      if (path === "dashboard") return '<div id="fnReactHolder"></div>';
      if (path === "navigation/groups")
        return {
          groups: [{ ID: 102, name: "Youth Ministry", shortname: "youth" }],
        };
      if (path === "network/getMetadata") return { everyoneGroupID: 101 };
      if (path === "user/userData") return state.verification;
      if (!state.pages.has(path))
        throw new Error("Missing fictional roster fixture");
      const value = state.pages.get(path);
      if (value instanceof Error) throw value;
      if (typeof value === "function") return value();
      return value;
    }),
  };
  const factory = vi.fn(async () => session);
  const connection = new BrowserConnection({
    profile,
    factory,
    coordinator: new SerialCoordinator(),
  });
  const server = createFlocknoteServer(connection);
  const client = new Client({
    name: "fictional-roster-assistant",
    version: "1",
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  cleanup.push(async () => {
    await client.close();
    await connection.close();
    rmSync(profile, { recursive: true, force: true });
  });
  return { state, session, factory, connection, client };
}

describe("group-members MCP workflow", () => {
  it("answers a named group request with member names and no default contact data", async () => {
    const f = await fixture();
    const result = await f.client.callTool({
      name: "group_members",
      arguments: { groupName: "Youth Ministry" },
    });
    expect(result.structuredContent).toMatchObject({
      ok: true,
      groupId: "102",
      groupName: "Youth Ministry",
      members: [
        { firstName: "Alex", lastName: "Rivera" },
        { firstName: "Bailey", lastName: "Morgan" },
      ],
      returnedCount: 2,
      hasMore: false,
      nextOffset: null,
    });
    expect(JSON.stringify(result)).not.toMatch(/@|555|pendingMembers|canAdmin/);
    expect(f.session.request).not.toHaveBeenCalledWith("user/userData");
    expect(f.session.request).toHaveBeenLastCalledWith(
      "group/102/people?ajax",
      "POST",
      "includeUnsubscribed=0",
    );
    expect(f.client.getInstructions()).toContain(
      "Never present the first page as the whole group",
    );
    const { tools } = await f.client.listTools();
    expect(
      tools.find((t) => t.name === "group_members")?.annotations?.readOnlyHint,
    ).toBe(true);
  });

  it("continues through the next page using the returned group ID and offset", async () => {
    const f = await fixture();
    f.state.pages.set(
      "group/102/people?ajax",
      rosterPage(
        Array.from({ length: 100 }, (_, i) => rosterRow(301 + i)),
        true,
      ),
    );
    f.state.pages.set(
      "group/102/people/100?ajax&more",
      rosterPage([rosterRow(401)], false, null),
    );
    const first = (
      await f.client.callTool({
        name: "group_members",
        arguments: { groupName: "Youth Ministry" },
      })
    ).structuredContent as unknown as GroupMembersResult;
    expect(first).toMatchObject({
      returnedCount: 100,
      hasMore: true,
      nextOffset: 100,
    });
    const last = await f.client.callTool({
      name: "group_members",
      arguments: { groupId: first.groupId, offset: first.nextOffset },
    });
    expect(last.structuredContent).toMatchObject({
      offset: 100,
      members: [{ id: "401" }],
      returnedCount: 1,
      hasMore: false,
      nextOffset: null,
    });
    expect(f.session.request).toHaveBeenLastCalledWith(
      "group/102/people/100?ajax&more",
      "POST",
      "includeUnsubscribed=0",
    );
  });

  it("answers a join-date follow-up by explicitly fetching dates from the previously listed group", async () => {
    const f = await fixture();
    f.state.pages.set(
      "group/102/people?ajax",
      rosterPage([
        rosterRow(),
        { ...rosterRow(302, "Bailey", "Morgan"), date: null },
      ]),
    );
    const names = (
      await f.client.callTool({
        name: "group_members",
        arguments: { groupName: "Youth Ministry" },
      })
    ).structuredContent as unknown as GroupMembersResult;
    expect(JSON.stringify(names)).not.toContain("joinedOn");
    const selectedPerson = names.members[0];
    const result = await f.client.callTool({
      name: "group_members",
      arguments: { groupId: names.groupId, fields: ["joinedOn"] },
    });
    const dates = result.structuredContent as unknown as GroupMembersResult;
    expect(dates).toMatchObject({
      ok: true,
      groupId: names.groupId,
      members: [
        { id: selectedPerson?.id, joinedOn: "2026-03-05" },
        { id: "302", joinedOn: null },
      ],
      hasMore: false,
    });
    expect(JSON.stringify(result)).not.toMatch(/@|555/);
    expect(f.client.getInstructions()).toContain(
      "An omitted joinedOn means it was not requested, not that Flocknote has no date",
    );
    expect(f.client.getInstructions()).toContain(
      "request joinedOn on every page before making a group-wide claim",
    );
    expect(f.session.request).not.toHaveBeenCalledWith("user/userData");
  });

  it("validates selectors, offsets and fields before starting the browser or IPC owner", async () => {
    const f = await fixture();
    for (const input of [
      {},
      { groupId: "102", groupName: "Youth Ministry" },
      { groupId: "102", offset: -1 },
    ])
      await expect(f.connection.groupMembers(input)).rejects.toMatchObject({
        code: "invalid_input",
      });
    expect(f.factory).not.toHaveBeenCalled();
    expect(
      brokerRequestSchema.safeParse({
        action: "group_members",
        groupId: "102",
        offset: 100,
        fields: ["email", "mobilePhone", "joinedOn"],
      }).success,
    ).toBe(true);
    for (const extra of [
      { path: "arbitrary" },
      { fields: ["unknown"] },
      { offset: 1.5 },
    ])
      expect(
        brokerRequestSchema.safeParse({
          action: "group_members",
          groupId: "102",
          ...extra,
        }).success,
      ).toBe(false);
  });

  it("only returns contact fields when explicitly requested", async () => {
    const f = await fixture();
    const result = await f.client.callTool({
      name: "group_members",
      arguments: { groupId: "102", fields: ["email"] },
    });
    expect(result.structuredContent).toMatchObject({
      members: [
        { email: { value: "alex@example.test", verified: false } },
        { email: { value: "alex@example.test", verified: false } },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("555");
  });

  it("does not replace a denied or malformed roster with an empty successful list", async () => {
    const f = await fixture();
    for (const [response, code] of [
      [{ canView: false }, "permission_denied"],
      [{ success: false, error: "private@example.test" }, "upstream_rejected"],
      [{ subscribedMembers: [] }, "invalid_response"],
    ] as const) {
      f.state.pages.set("group/102/people?ajax", response);
      const result = await f.client.callTool({
        name: "group_members",
        arguments: { groupId: "102" },
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ ok: false, code });
      expect(JSON.stringify(result)).not.toContain("private@");
    }
    expect(f.session.request).toHaveBeenCalledTimes(3);
    expect(await f.connection.status()).toMatchObject({ state: "ready" });
  });

  it("diagnoses explicit expiry once without replaying the roster POST", async () => {
    const f = await fixture();
    f.state.pages.set("group/102/people?ajax", {
      authorized: false,
      success: false,
    });
    f.state.verification = { success: true, userID: null, authorized: false };
    await expect(
      f.connection.groupMembers({ groupId: "102" }),
    ).rejects.toMatchObject({ code: "authentication_required" });
    expect(f.session.request).toHaveBeenCalledTimes(2);
    expect(f.session.request).toHaveBeenLastCalledWith("user/userData");
  });

  it("cancels queued and in-flight reads without starting another roster request", async () => {
    const f = await fixture();
    await expect(
      f.connection.groupMembers(
        { groupId: "102" },
        { signal: AbortSignal.abort() },
      ),
    ).rejects.toMatchObject({ code: "operation_cancelled" });
    expect(f.factory).not.toHaveBeenCalled();
    let finish = (_value: unknown) => {};
    f.state.pages.set(
      "group/102/people?ajax",
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const controller = new AbortController();
    const pending = f.connection.groupMembers(
      { groupId: "102" },
      { signal: controller.signal },
    );
    await waitFor(() => expect(f.session.request).toHaveBeenCalledTimes(1));
    try {
      controller.abort();
      await expect(pending).rejects.toMatchObject({
        code: "operation_cancelled",
      });
      expect(f.session.request).toHaveBeenCalledTimes(1);
    } finally {
      finish(rosterPage());
    }
  });
});
