import { inspect } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { MemberSearch } from "../src/models/member-search.js";
import { Network } from "../src/models/network.js";
import { searchMetadata, searchRow } from "./fixtures/member-search.js";

function fixture(rows: unknown[] = [searchRow()], resultCount = rows.length) {
  const metadata = searchMetadata();
  const data = { success: true, results: rows, resultCount };
  const context = {
    check: vi.fn(),
    read: vi.fn(async (path: string): Promise<unknown> => {
      if (path === "dashboard") return '<div id="fnReactHolder"></div>';
      if (path === "navigation/groups")
        return { groups: [{ ID: 102, name: "Choir", shortname: "choir" }] };
      if (path === "network/getMetadata") return { everyoneGroupID: 101 };
      throw new Error("Missing fictional fixture");
    }),
    query: vi.fn(
      async (path: string, _body?: string): Promise<unknown> =>
        path.endsWith("?ajax") ? metadata : data,
    ),
  };
  const find = async (input = {}) =>
    new MemberSearch({ searchTerm: "Alex Rivera", ...input }).find(
      context,
      new Network("example-parish"),
    );
  return { context, data, metadata, find };
}

describe("member search domain reads", () => {
  it("discovers Everyone and resolves the metadata filter rather than a fixed ID", async () => {
    const f = fixture();
    expect(await f.find()).toEqual({
      groupId: "101",
      includeInactive: false,
      members: [{ id: "301", firstName: "Alex", lastName: "Rivera" }],
      resultCount: 1,
      returnedCount: 1,
      complete: true,
      exactMatchUserId: "301",
    });
    expect(f.context.query.mock.calls[0]).toEqual([
      "group/101/people?ajax",
      "includeUnsubscribed=0",
    ]);
    const second = f.context.query.mock.calls[1];
    expect(second?.[0]).toBe("group/101/filter");
    expect(Object.fromEntries(new URLSearchParams(second?.[1]))).toEqual({
      "request[and][0][or][0][and][0][filterID]": "17",
      "request[and][0][or][0][and][0][isNegated]": "false",
      "request[and][0][or][0][and][0][inputs][searchTerm]": "Alex Rivera",
      includeInactive: "false",
    });
  });

  it("uses explicit normalized IDs without discovery, or resolves a unique group name", async () => {
    const direct = fixture();
    expect(await direct.find({ groupId: "000102" })).toMatchObject({
      groupId: "102",
    });
    expect(direct.context.read).not.toHaveBeenCalled();
    const named = fixture();
    expect(await named.find({ groupName: "  CHOIR " })).toMatchObject({
      groupId: "102",
    });
    await expect(
      fixture().find({ groupName: "Missing" }),
    ).rejects.toMatchObject({ code: "group_not_found" });
  });

  it("does not guess a group when Everyone is missing or names are ambiguous", async () => {
    const f = fixture();
    f.context.read.mockImplementation(async (path) => {
      if (path === "dashboard") return '<div id="fnReactHolder"></div>';
      if (path === "navigation/groups")
        return {
          groups: [
            { ID: 102, name: "Choir", shortname: "choir-a" },
            { ID: 103, name: "CHOIR", shortname: "choir-b" },
          ],
        };
      return { everyoneGroupID: null };
    });
    await expect(f.find()).rejects.toMatchObject({
      code: "everyone_not_found",
    });
    await expect(f.find({ groupName: "choir" })).rejects.toMatchObject({
      code: "group_ambiguous",
    });
    expect(f.context.query).not.toHaveBeenCalled();
  });

  it.each([
    { searchTerm: "" },
    { searchTerm: "\nAlex" },
    { searchTerm: "x".repeat(257) },
    { groupId: "../people" },
    { groupId: "0" },
    { groupId: "101", groupName: "Choir" },
    { groupName: " " },
    { fields: ["email", "email"] },
    { fields: ["unknown"] },
    { fields: ["joinedOn", "joinedOn"] },
    { fields: ["email", "mobilePhone", "joinedOn", "joinedOn"] },
    { limit: 0 },
    { limit: 51 },
    { limit: 1.5 },
    { limit: null },
  ])("rejects invalid input before any I/O: %j", async (input) => {
    const f = fixture();
    await expect(f.find(input)).rejects.toMatchObject({
      code: "invalid_input",
    });
    expect(f.context.query).not.toHaveBeenCalled();
    expect(f.context.read).not.toHaveBeenCalled();
  });

  it("exposes only explicitly selected contacts and normalizes known flag encodings", async () => {
    const f = fixture([{ ...searchRow(), mailVer: 0, phnVer: 1 }]);
    const value = await f.find({ fields: ["email"] });
    expect(value.members[0]).toEqual({
      id: "301",
      firstName: "Alex",
      lastName: "Rivera",
      email: { value: "alex@example.test", verified: false },
    });
    expect(JSON.stringify(value)).not.toContain("555");
    expect(
      (await f.find({ fields: ["mobilePhone"] })).members[0],
    ).toMatchObject({
      mobilePhone: { value: "+1 (202) 555-0123", verified: true },
    });
  });

  it.each([null, "", "   "])(
    "preserves absent selected contacts as null for %j (simulated edge case)",
    async (value) => {
      const result = await fixture([
        { ...searchRow(), mail: value, phn: value },
      ]).find({ fields: ["email", "mobilePhone"] });
      expect(result.members[0]).toMatchObject({
        email: { value: null, verified: false },
        mobilePhone: { value: null, verified: true },
      });
    },
  );

  it.each(["mail", "phn"])(
    "rejects a missing selected %s key instead of inventing a value",
    async (field) => {
      const row: Record<string, unknown> = searchRow();
      delete row[field];
      await expect(
        fixture([row]).find({ fields: ["email", "mobilePhone"] }),
      ).rejects.toMatchObject({ code: "invalid_response" });
    },
  );

  it("retains a unique exact match below a lower presentation limit", async () => {
    expect(await fixture().find({ limit: 5 })).toMatchObject({
      complete: true,
      exactMatchUserId: "301",
    });
  });

  it("hides search intent during default inspection and snapshots mutable fields", async () => {
    const fields: ("email" | "mobilePhone")[] = ["email"];
    const search = new MemberSearch({
      searchTerm: "private@example.test",
      fields,
      groupId: "101",
    });
    fields.push("mobilePhone");
    expect(JSON.stringify(search)).not.toContain("private@");
    expect(inspect(search)).not.toContain("private@");
    expect(Object.keys(search)).toEqual([]);
    expect(search.toInput().fields).toEqual(["email"]);
  });

  it("marks one exact case/whitespace-normalized match even beside distinct candidates", async () => {
    const f = fixture([searchRow(), searchRow(302, "Alexandra")]);
    expect(await f.find({ searchTerm: "  ALEX   RIVERA  " })).toMatchObject({
      exactMatchUserId: "301",
      complete: true,
    });
  });

  it("requires clarification for duplicate exact or merely similar names", async () => {
    for (const rows of [
      [searchRow(), searchRow(302)],
      [searchRow(301, "Alexandra")],
    ]) {
      expect(await fixture(rows).find()).not.toHaveProperty("exactMatchUserId");
    }
  });

  it("resolves one exact selected email in complete results without exposing an unrelated contact", async () => {
    const f = fixture([
      searchRow(),
      { ...searchRow(302), mail: "another@example.test" },
    ]);
    expect(
      await f.find({
        searchTerm: "ALEX@example.test",
        groupId: "102",
        fields: ["email", "joinedOn"],
      }),
    ).toMatchObject({
      groupId: "102",
      exactMatchUserId: "301",
      members: [{ id: "301", joinedOn: "2026-03-05" }, { id: "302" }],
    });
    const withoutEmail = await fixture().find({
      searchTerm: "alex@example.test",
      fields: ["joinedOn"],
    });
    expect(withoutEmail).not.toHaveProperty("exactMatchUserId");
    expect(JSON.stringify(withoutEmail)).not.toContain("alex@");
  });

  it("does not select a duplicated email or an email in incomplete results", async () => {
    for (const f of [
      fixture([searchRow(), searchRow(302)]),
      fixture([searchRow()], 2),
    ])
      expect(
        await f.find({ searchTerm: "alex@example.test", fields: ["email"] }),
      ).not.toHaveProperty("exactMatchUserId");
  });

  it("keeps subscription dates scoped to the searched group for the same person", async () => {
    const f = fixture();
    f.context.query.mockImplementation(async (path) =>
      path.endsWith("?ajax")
        ? f.metadata
        : {
            ...f.data,
            results: [
              {
                ...searchRow(),
                date: path.startsWith("group/102/")
                  ? "Apr 6, 2026"
                  : "Mar 5, 2026",
              },
            ],
          },
    );
    expect(
      await f.find({ groupId: "101", fields: ["joinedOn"] }),
    ).toMatchObject({
      groupId: "101",
      members: [{ joinedOn: "2026-03-05" }],
    });
    expect(
      await f.find({ groupId: "102", fields: ["joinedOn"] }),
    ).toMatchObject({
      groupId: "102",
      members: [{ joinedOn: "2026-04-06" }],
    });
    expect(await fixture().find()).not.toHaveProperty("members.0.joinedOn");
  });

  it.each([
    ["Feb 29, 2024", "2024-02-29"],
    ["Feb 29, 2000", "2000-02-29"],
    ["Feb 29, 1900", null],
    ["Feb 29, 2025", null],
    ["Apr 31, 2026", null],
    ["Mar 0, 2026", null],
    ["Mar 5, 0000", null],
    ["2026-03-05T12:00:00Z", null],
    ["yesterday", null],
    ["", null],
    [null, null],
    [undefined, null],
    [123, null],
  ])(
    "reports the calendar date or unknown for simulated date %j",
    async (date, expected) => {
      expect(
        await fixture([{ ...searchRow(), date }]).find({
          fields: ["joinedOn"],
        }),
      ).toMatchObject({ members: [{ joinedOn: expected }] });
    },
  );

  it("makes both server-side and caller-side truncation visible without an exact selection", async () => {
    const server = await fixture([searchRow()], 2).find();
    expect(server).toMatchObject({
      resultCount: 2,
      returnedCount: 1,
      complete: false,
    });
    expect(server).not.toHaveProperty("exactMatchUserId");
    const caller = await fixture([
      searchRow(),
      searchRow(302, "Alexandra"),
    ]).find({ limit: 1 });
    expect(caller).toMatchObject({
      resultCount: 2,
      returnedCount: 1,
      complete: false,
    });
    expect(caller).not.toHaveProperty("exactMatchUserId");
    expect(await fixture([]).find()).toMatchObject({
      resultCount: 0,
      returnedCount: 0,
      complete: true,
    });
  });

  it("caps default presentation at 50 candidates without losing the upstream count", async () => {
    const rows = Array.from({ length: 51 }, (_, index) =>
      searchRow(301 + index, "Alex", `Rivera ${index}`),
    );
    const result = await fixture(rows).find();
    expect(result).toMatchObject({
      resultCount: 51,
      returnedCount: 50,
      complete: false,
    });
    expect(result.members).toHaveLength(50);
    expect(result).not.toHaveProperty("exactMatchUserId");
  });

  it.each([
    { results: [searchRow(), searchRow()] },
    { resultCount: -1 },
    { resultCount: "1" },
    { resultCount: 0 },
    { resultCount: Number.MAX_SAFE_INTEGER + 1 },
    { results: null },
    { results: [{ ...searchRow(), userID: 0 }] },
    { results: [{ ...searchRow(), fn: null }] },
    { results: [{ ...searchRow(), mailVer: "false" }] },
  ])("rejects malformed/contradictory results: %j", async (change) => {
    const f = fixture();
    Object.assign(f.data, change);
    await expect(f.find({ fields: ["email"] })).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it("does not submit a filter when the metadata contract changes", async () => {
    const f = fixture();
    f.metadata.peopleFilterInfo.generalSearchFilter.filterName =
      "anotherFilter";
    await expect(f.find()).rejects.toMatchObject({ code: "invalid_response" });
    expect(f.context.query).toHaveBeenCalledTimes(1);
  });

  it("propagates rejection and cancellation without replaying POST reads", async () => {
    const f = fixture();
    f.data.success = false;
    await expect(f.find()).rejects.toMatchObject({ code: "upstream_rejected" });
    expect(f.context.query).toHaveBeenCalledTimes(2);
    const cancelled = fixture();
    cancelled.context.check.mockImplementation(() => {
      throw new Error("cancelled");
    });
    await expect(cancelled.find()).rejects.toThrow("cancelled");
    expect(cancelled.context.query).not.toHaveBeenCalled();
  });
});
