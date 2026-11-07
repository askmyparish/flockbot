import { inspect } from "node:util";
import { describe, expect, it, vi } from "vitest";
import {
  MemberGroups,
  membershipGroupSelector,
  type GroupSelector,
} from "../src/models/member-groups.js";
import { Network } from "../src/models/network.js";
import { membershipResponse, membershipRow } from "./fixtures/member-groups.js";

function fixture() {
  const response: Record<string, unknown> = membershipResponse();
  const data = response.data as Record<string, unknown>;
  const context = {
    check: vi.fn(),
    query: vi.fn(async (): Promise<unknown> => response),
    read: vi.fn(async (path: string): Promise<unknown> => {
      if (path === "dashboard") return '<div id="fnReactHolder"></div>';
      if (path === "navigation/groups")
        return {
          groups: [
            { ID: 102, name: "Choir", shortname: "choir" },
            { ID: 104, name: "Readers", shortname: "readers" },
          ],
        };
      return { everyoneGroupID: 101 };
    }),
  };
  const model = new MemberGroups("301");
  const list = () => model.list(context);
  const check = (selector: GroupSelector) =>
    model.check(context, new Network("example-parish"), selector);
  return { response, data, context, model, list, check };
}

describe("member subscription reads", () => {
  it("returns only positively subscribed IDs/names and records visibility limits", async () => {
    const f = fixture();
    expect(await f.list()).toEqual({
      userId: "301",
      groups: [
        { id: "101", name: "Everyone" },
        { id: "102", name: "Choir" },
      ],
      observedCount: 2,
      returnedCount: 2,
      truncated: false,
      complete: false,
    });
    expect(f.context.query).toHaveBeenCalledExactlyOnceWith("user/301/groups");
    expect(f.context.read).not.toHaveBeenCalled();
    expect(JSON.stringify(await f.list())).not.toMatch(
      /Pref|superAdmin|available|Proxy|Readers/,
    );
  });

  it("uses true, explicit proxy-only false, and absent target as distinct outcomes", async () => {
    const f = fixture();
    expect(await f.check({ groupId: "000102" })).toEqual({
      userId: "301",
      groupId: "102",
      groupName: "Choir",
      membership: "member",
    });
    expect(await f.check({ groupId: "103" })).toMatchObject({
      userId: "301",
      groupId: "103",
      membership: "not_member",
    });
    // Available rows have no explicit subscription flag and cannot establish a negative.
    expect(await f.check({ groupId: "104" })).toEqual({
      userId: "301",
      groupId: "104",
      membership: "unknown",
    });
    expect(f.context.read).not.toHaveBeenCalled();
  });

  it("resolves a unique case-insensitive group name or fails before membership reads", async () => {
    const f = fixture();
    expect(await f.check({ groupName: " CHOIR " })).toMatchObject({
      groupId: "102",
      groupName: "Choir",
      membership: "member",
    });
    const missing = fixture();
    await expect(missing.check({ groupName: "Missing" })).rejects.toMatchObject(
      { code: "group_not_found" },
    );
    expect(missing.context.query).not.toHaveBeenCalled();
    const ambiguous = fixture();
    ambiguous.context.read.mockImplementation(async (path) => {
      if (path === "dashboard") return '<div id="fnReactHolder"></div>';
      if (path === "navigation/groups")
        return {
          groups: [
            { ID: 102, name: "Choir", shortname: "choir-a" },
            { ID: 105, name: "CHOIR", shortname: "choir-b" },
          ],
        };
      return { everyoneGroupID: 101 };
    });
    await expect(ambiguous.check({ groupName: "choir" })).rejects.toMatchObject(
      { code: "group_ambiguous" },
    );
    expect(ambiguous.context.query).not.toHaveBeenCalled();
  });

  it("clips list presentation at 50 while checking all validated relationships", async () => {
    const f = fixture();
    f.data.subscribedGroups = Array.from({ length: 52 }, (_, index) =>
      membershipRow(1000 + index, `Group ${index}`),
    );
    expect(await f.list()).toMatchObject({
      observedCount: 52,
      returnedCount: 50,
      truncated: true,
      complete: false,
    });
    expect(await f.check({ groupId: "1051" })).toMatchObject({
      membership: "member",
      groupId: "1051",
    });
  });

  it("keeps an empty authorized response non-exhaustive", async () => {
    const f = fixture();
    f.data.subscribedGroups = [];
    expect(await f.list()).toMatchObject({
      groups: [],
      observedCount: 0,
      returnedCount: 0,
      complete: false,
      truncated: false,
    });
    expect(await f.check({ groupId: "102" })).toMatchObject({
      membership: "unknown",
    });
  });

  it.each([
    {},
    { groupId: "102", groupName: "Choir" },
    { groupId: "../102" },
    { groupName: " " },
    { groupId: "0" },
  ])(
    "rejects invalid group selectors before any read: %j",
    async (selector) => {
      const f = fixture();
      await expect(f.check(selector)).rejects.toMatchObject({
        code: "invalid_input",
      });
      expect(f.context.query).not.toHaveBeenCalled();
      expect(f.context.read).not.toHaveBeenCalled();
    },
  );

  it.each([
    { canView: undefined },
    { canView: "true" },
    { subscribedGroups: null },
    { subscribedGroups: [membershipRow(), membershipRow()] },
    { subscribedGroups: [membershipRow(), membershipRow(102, "Choir", false)] },
    { subscribedGroups: [{ ...membershipRow(), isSubscribed: 0 }] },
    { subscribedGroups: [{ ...membershipRow(), isSubscribed: "false" }] },
    { subscribedGroups: [{ ...membershipRow(), groupID: 0 }] },
    { subscribedGroups: [{ ...membershipRow(), groupName: " " }] },
  ])("rejects malformed or conflicting membership data: %j", async (change) => {
    const f = fixture();
    Object.assign(f.data, change);
    await expect(f.check({ groupId: "102" })).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it("denies forbidden views rather than reporting nonmembership", async () => {
    const f = fixture();
    f.data.canView = false;
    await expect(f.list()).rejects.toMatchObject({ code: "permission_denied" });
    await expect(f.check({ groupId: "102" })).rejects.toMatchObject({
      code: "permission_denied",
    });
  });

  it("validates user IDs and snapshots selectors without default inspection exposure", () => {
    for (const userId of ["0", "../301", "x".repeat(129)])
      expect(() => new MemberGroups(userId)).toThrow(/invalid_input/);
    const model = new MemberGroups("000301");
    expect(model.toInput()).toEqual({ userId: "301" });
    expect(Object.keys(model)).toEqual([]);
    expect(inspect(model)).not.toContain("301");
    expect(JSON.stringify(model)).not.toContain("301");
    const selector = { groupId: "000102" };
    const prepared = membershipGroupSelector(selector);
    selector.groupId = "103";
    expect(prepared).toEqual({ groupId: "102" });
  });

  it("propagates rejected/cancelled reads without a membership answer", async () => {
    const rejected = fixture();
    rejected.response.success = false;
    await expect(rejected.check({ groupId: "102" })).rejects.toMatchObject({
      code: "upstream_rejected",
    });
    const cancelled = fixture();
    cancelled.context.check.mockImplementation(() => {
      throw new Error("cancelled");
    });
    await expect(cancelled.list()).rejects.toThrow("cancelled");
    expect(cancelled.context.query).not.toHaveBeenCalled();
  });
});
