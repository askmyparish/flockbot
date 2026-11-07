import { inspect } from "node:util";
import { describe, expect, it, vi } from "vitest";
import {
  GroupMembers,
  type GroupMembersInput,
} from "../src/models/group-members.js";
import { Network } from "../src/models/network.js";
import { rosterPage, rosterRow } from "./fixtures/group-members.js";

function fixture() {
  const page = rosterPage();
  const pages = new Map<string, unknown>([["group/102/people?ajax", page]]);
  const context = {
    check: vi.fn(),
    read: vi.fn(async (path: string): Promise<unknown> => {
      if (path === "dashboard") return '<div id="fnReactHolder"></div>';
      if (path === "navigation/groups")
        return {
          groups: [{ ID: 102, name: "Youth Ministry", shortname: "youth" }],
        };
      if (path === "network/getMetadata") return { everyoneGroupID: 101 };
      throw new Error("Missing fictional group fixture");
    }),
    query: vi.fn(async (path: string, _body?: string): Promise<unknown> => {
      if (!pages.has(path)) throw new Error("Missing fictional page fixture");
      const value = pages.get(path);
      if (value instanceof Error) throw value;
      return value;
    }),
  };
  const list = async (input: unknown = { groupName: "Youth Ministry" }) =>
    new GroupMembers(input as GroupMembersInput).list(
      context,
      new Network("example-parish"),
    );
  return { page, pages, context, list };
}

describe("group subscriber pages", () => {
  it("resolves a group name and returns only names/internal identifiers by default", async () => {
    const f = fixture();
    f.page.pendingMembers = [{ privateContact: "pending@example.test" }];
    expect(await f.list({ groupName: "  YOUTH MINISTRY " })).toEqual({
      groupId: "102",
      groupName: "Youth Ministry",
      members: [
        { id: "301", firstName: "Alex", lastName: "Rivera" },
        { id: "302", firstName: "Bailey", lastName: "Morgan" },
      ],
      offset: 0,
      returnedCount: 2,
      hasMore: false,
      nextOffset: null,
      includeUnsubscribed: false,
    });
    expect(f.context.query).toHaveBeenCalledWith(
      "group/102/people?ajax",
      "includeUnsubscribed=0",
    );
    expect(JSON.stringify(await f.list())).not.toMatch(
      /@|555|pendingMembers|canAdmin|joinedOn/,
    );
  });

  it("uses an explicit normalized group ID without discovery", async () => {
    const f = fixture();
    expect(await f.list({ groupId: "000102" })).toMatchObject({
      groupId: "102",
    });
    expect(f.context.read).not.toHaveBeenCalled();
  });

  it("returns an offset for the next page without calling the initial 100 people the whole group", async () => {
    const f = fixture();
    const rows = Array.from({ length: 100 }, (_, i) =>
      rosterRow(301 + i, "Alex", `Example${i}`),
    );
    f.pages.set("group/102/people?ajax", rosterPage(rows, true));
    f.pages.set(
      "group/102/people/100?ajax&more",
      rosterPage([rosterRow(401), rosterRow(402)], false, null),
    );
    const first = await f.list({ groupId: "102" });
    expect(first).toMatchObject({
      offset: 0,
      returnedCount: 100,
      hasMore: true,
      nextOffset: 100,
    });
    const last = await f.list({
      groupId: first.groupId,
      offset: first.nextOffset,
    });
    expect(last).toMatchObject({
      offset: 100,
      returnedCount: 2,
      hasMore: false,
      nextOffset: null,
    });
    expect(
      new Set([...first.members, ...last.members].map((m) => m.id)).size,
    ).toBe(102);
    expect(f.context.query.mock.calls[1]).toEqual([
      "group/102/people/100?ajax&more",
      "includeUnsubscribed=0",
    ]);
  });

  it("accepts an explicit empty final page without fabricating members", async () => {
    const f = fixture();
    f.page.subscribedMembers = [];
    expect(await f.list()).toMatchObject({
      members: [],
      returnedCount: 0,
      hasMore: false,
      nextOffset: null,
    });
  });

  it("returns only requested contacts and normalizes both captured verification flag types", async () => {
    const f = fixture();
    expect(await f.list({ groupId: "102", fields: ["email"] })).toMatchObject({
      members: [
        { email: { value: "alex@example.test", verified: false } },
        { email: { value: "alex@example.test", verified: false } },
      ],
    });
    f.page.subscribedMembers = [{ ...rosterRow(), phnVer: true }];
    const result = await f.list({ groupId: "102", fields: ["mobilePhone"] });
    expect(result.members[0]).toMatchObject({
      mobilePhone: { value: "+1 (202) 555-0123", verified: true },
    });
    expect(JSON.stringify(result)).not.toContain("@example.test");
    expect(
      await f.list({
        groupId: "102",
        fields: ["email", "mobilePhone", "joinedOn"],
      }),
    ).toMatchObject({
      members: [
        {
          email: { value: "alex@example.test" },
          mobilePhone: { value: "+1 (202) 555-0123" },
          joinedOn: "2026-03-05",
        },
      ],
    });
  });

  it("fetches requested dates after a names-only roster without treating omission as unavailable", async () => {
    const f = fixture();
    f.page.subscribedMembers = [
      rosterRow(),
      { ...rosterRow(302), date: undefined },
      { ...rosterRow(303), date: null },
      { ...rosterRow(304), date: "unrecognized" },
    ];
    expect(JSON.stringify(await f.list())).not.toContain("joinedOn");
    const dates = await f.list({ groupId: "102", fields: ["joinedOn"] });
    expect(dates.members).toEqual([
      {
        id: "301",
        firstName: "Alex",
        lastName: "Rivera",
        joinedOn: "2026-03-05",
      },
      { id: "302", firstName: "Alex", lastName: "Rivera", joinedOn: null },
      { id: "303", firstName: "Alex", lastName: "Rivera", joinedOn: null },
      { id: "304", firstName: "Alex", lastName: "Rivera", joinedOn: null },
    ]);
    expect(JSON.stringify(dates)).not.toMatch(/@|555/);
  });

  it("reports the selected group's date when the same person belongs to two groups", async () => {
    const f = fixture();
    f.pages.set(
      "group/103/people?ajax",
      rosterPage([{ ...rosterRow(), date: "Apr 6, 2026" }], false, 103),
    );
    expect(
      await f.list({ groupId: "102", fields: ["joinedOn"] }),
    ).toMatchObject({
      groupId: "102",
      members: [{ id: "301", joinedOn: "2026-03-05" }, { id: "302" }],
    });
    expect(
      await f.list({ groupId: "103", fields: ["joinedOn"] }),
    ).toMatchObject({
      groupId: "103",
      members: [{ id: "301", joinedOn: "2026-04-06" }],
    });
    expect(f.context.read).not.toHaveBeenCalled();
  });

  it.each([
    {},
    { groupId: "102", groupName: "Youth Ministry" },
    { groupName: " " },
    { groupId: "../people" },
    { groupId: "0" },
    { groupId: "102", offset: -1 },
    { groupId: "102", offset: 1.5 },
    { groupId: "102", offset: null },
    { groupId: "102", offset: Number.MAX_SAFE_INTEGER },
    { groupId: "102", fields: ["email", "email"] },
    { groupId: "102", fields: ["unknown"] },
    { groupId: "102", fields: ["joinedOn", "joinedOn"] },
    {
      groupId: "102",
      fields: ["email", "mobilePhone", "joinedOn", "joinedOn"],
    },
  ])("rejects invalid arguments before any I/O: %j", async (input) => {
    const f = fixture();
    await expect(f.list(input)).rejects.toMatchObject({
      code: "invalid_input",
    });
    expect(f.context.read).not.toHaveBeenCalled();
    expect(f.context.query).not.toHaveBeenCalled();
  });

  it("does not select a missing or ambiguous group", async () => {
    const f = fixture();
    await expect(f.list({ groupName: "Missing" })).rejects.toMatchObject({
      code: "group_not_found",
    });
    f.context.read.mockImplementation(async (path) =>
      path === "dashboard"
        ? '<div id="fnReactHolder"></div>'
        : path === "navigation/groups"
          ? {
              groups: [
                { ID: 102, name: "Youth Ministry", shortname: "youth-a" },
                { ID: 103, name: "YOUTH MINISTRY", shortname: "youth-b" },
              ],
            }
          : { everyoneGroupID: 101 },
    );
    await expect(f.list()).rejects.toMatchObject({ code: "group_ambiguous" });
    expect(f.context.query).not.toHaveBeenCalled();
  });

  it.each([
    { subscribedMembers: null },
    { moreSubscribersExist: undefined },
    { moreSubscribersExist: 1 },
    { subscribedMembers: [], moreSubscribersExist: true },
    {
      subscribedMembers: Array.from({ length: 101 }, (_, i) =>
        rosterRow(301 + i),
      ),
    },
    { subscribedMembers: [rosterRow(), rosterRow()] },
    { subscribedMembers: [{ ...rosterRow(), userID: 0 }] },
    { subscribedMembers: [{ ...rosterRow(), fn: null }] },
    { subscribedMembers: [{ ...rosterRow(), mailVer: "false" }] },
    { groupID: 103 },
    { includeContacts: true },
    {
      subscribedMembers: [
        { ...rosterRow(), contactData: { email: "private@example.test" } },
      ],
    },
  ])(
    "fails clearly on malformed/nonprogressing/unsupported pages: %j",
    async (change) => {
      const f = fixture();
      Object.assign(f.page, change);
      await expect(
        f.list({ groupId: "102", fields: ["email"] }),
      ).rejects.toMatchObject({ code: "invalid_response" });
    },
  );

  it("preserves denial, rejection and cancellation instead of returning an empty list", async () => {
    const f = fixture();
    Object.assign(f.page, { canView: false });
    await expect(f.list()).rejects.toMatchObject({ code: "permission_denied" });
    Object.assign(f.page, { success: false });
    await expect(f.list()).rejects.toMatchObject({ code: "upstream_rejected" });
    f.context.check.mockImplementation(() => {
      throw new Error("cancelled");
    });
    await expect(f.list()).rejects.toThrow("cancelled");
  });

  it("snapshots selected fields and redacts default inspection", () => {
    const fields: ("email" | "mobilePhone")[] = ["email"];
    const page = new GroupMembers({ groupName: "Private Group", fields });
    fields.push("mobilePhone");
    expect(page.toInput().fields).toEqual(["email"]);
    expect(Object.keys(page)).toEqual([]);
    expect(JSON.stringify(page)).not.toContain("Private Group");
    expect(inspect(page)).not.toContain("Private Group");
  });
});
