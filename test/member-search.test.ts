import { inspect } from "node:util";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  MemberSearch,
  type MemberSearchInput,
  type MemberSearchContinuation,
} from "../src/models/member-search.js";
import { FlockbotError } from "../src/errors.js";
import type { MemberPredicate } from "../src/models/member-filters.js";
import { Network } from "../src/models/network.js";
import { filterCatalog } from "./fixtures/member-filters.js";
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

function countFixture() {
  const catalog = filterCatalog();
  const data: Record<string, unknown> = {
    success: true,
    results: [{ mail: "private@example.test", fn: { invalid: "unused" } }],
    resultCount: 73,
  };
  const base = fixture();
  base.context.query.mockImplementation(async (path) =>
    path.endsWith("?ajax") ? catalog : data,
  );
  const count = (input: MemberSearchInput = { searchTerm: "Alex" }) =>
    new MemberSearch({ ...input, mode: "count" as const }).find(
      base.context,
      new Network("example-parish"),
    );
  return { ...base, catalog, data, count };
}
const criterion = (
  fieldId: string,
  operator: MemberPredicate["operator"],
  value?: string,
  negated = false,
): MemberPredicate => ({
  fieldId,
  operator,
  ...(value === undefined ? {} : { value }),
  negated,
});
const expression = (...branches: MemberPredicate[][]) => ({
  any: branches.map((all) => ({ all })),
});

describe("advanced member counts", () => {
  it("discards unused native rows, including malformed contacts, without traversing or resolving an identity", async () => {
    const f = countFixture();
    const result = await f.count();
    expect(result).toEqual({
      mode: "count",
      groupId: "101",
      includeInactive: false,
      resultCount: 73,
      criteriaSummary: {
        groupId: "101",
        includeInactive: false,
        searchTerm: "Alex",
        any: [],
      },
    });
    expect(JSON.stringify(result)).not.toMatch(
      /private|members|exactMatchUserId|returnedCount/,
    );
    expect(f.context.query.mock.calls.map(([path]) => path)).toEqual([
      "group/101/people?ajax",
      "group/101/filter",
    ]);
  });

  it("compiles OR-of-ANDs and outer text AND with native missing-phone semantics", async () => {
    const f = countFixture();
    const rows =
      f.catalog.peopleFilterInfo.filters["Contact Info"].categories[
        "Phone Number"
      ].filters;
    rows[0]!.filterID = 401; // phone exists
    rows[2]!.filterID = 402; // phone verified (missing excluded even when negated)
    // Independent fictional native evaluator: mixed names and missing/unverified/verified phones.
    const people = [
      { name: "Alex", phone: false, verified: false },
      { name: "Alex", phone: true, verified: false },
      { name: "Alex", phone: true, verified: true },
      { name: "Bea", phone: false, verified: false },
      { name: "Bea", phone: true, verified: false },
    ];
    f.context.query.mockImplementation(async (path, body) => {
      if (path.endsWith("?ajax")) return f.catalog;
      const form = new URLSearchParams(body);
      const clauses = new Map<string, Map<string, string[]>>();
      for (const key of form.keys()) {
        const match =
          /^(request\[and\]\[(\d+)\]\[or\]\[(\d+)\]\[and\]\[\d+\])\[filterID\]$/.exec(
            key,
          );
        if (!match) continue;
        const outer = clauses.get(match[2]!) ?? new Map<string, string[]>();
        clauses.set(match[2]!, outer);
        outer.set(match[3]!, [...(outer.get(match[3]!) ?? []), match[1]!]);
      }
      expect(clauses.size).toBeGreaterThan(0);
      const resultCount = people.filter((person) =>
        [...clauses.values()].every((alternatives) =>
          [...alternatives.values()].some((predicates) =>
            predicates.every((p) => {
              const id = form.get(`${p}[filterID]`),
                negated = form.get(`${p}[isNegated]`) === "true";
              if (id === "17")
                return person.name.includes(
                  form.get(`${p}[inputs][searchTerm]`)!,
                );
              if (id === "401") return negated ? !person.phone : person.phone;
              if (id === "402")
                return (
                  person.phone && (negated ? !person.verified : person.verified)
                );
              throw new Error("Unexpected fictional predicate");
            }),
          ),
        ),
      ).length;
      return { success: true, resultCount, results: [] };
    });
    const missing = criterion("phone", "exists", undefined, true),
      unverified = criterion("phone", "verified", undefined, true);
    expect(
      (await f.count({ criteria: expression([unverified]) })).resultCount,
    ).toBe(2);
    expect(
      (await f.count({ criteria: expression([missing], [unverified]) }))
        .resultCount,
    ).toBe(4);
    expect(
      (await f.count({ criteria: expression([missing, unverified]) }))
        .resultCount,
    ).toBe(0);
    const mixed = await f.count({
      searchTerm: "Alex",
      criteria: expression([missing], [unverified]),
    });
    expect(mixed.resultCount).toBe(2);
    expect(mixed.criteriaSummary.any[1]?.all[0]).toMatchObject({
      missingValueBehavior: "excluded",
      negated: true,
    });
  });

  it("binds repeated custom native IDs to the selected field and checks current choices on each operation", async () => {
    const f = countFixture();
    const input = {
      criteria: expression([
        criterion("custom:201:select:501", "equals", "1"),
        criterion("custom:202:select:502", "equals", "2"),
        criterion("membership", "in_group", "102"),
      ]),
    };
    const result = await f.count(input);
    const body = new URLSearchParams(f.context.query.mock.calls[1]?.[1]);
    for (const [i, field, instance, choice] of [
      [0, "201", "501", "1"],
      [1, "202", "502", "2"],
    ]) {
      const prefix = `request[and][0][or][0][and][${i}]`;
      expect(body.get(`${prefix}[filterID]`)).toBe("82");
      expect(body.get(`${prefix}[inputs][networkFieldID]`)).toBe(field);
      expect(body.get(`${prefix}[inputs][fieldTypeInstanceID]`)).toBe(instance);
      expect(body.get(`${prefix}[inputs][extendedFieldFieldType]`)).toBe("5");
      expect(body.get(`${prefix}[inputs][listOfIDs]`)).toBe(choice);
    }
    expect(result.criteriaSummary.any[0]?.all[2]).toMatchObject({
      value: "102",
      choiceLabel: "Choir",
    });
    f.catalog.peopleFilterInfo.filters["Personal Info"].categories.ChoiceB
      .filters[1]!.inputs.listOfIDs!.allowedValues = [
      { value: 1, label: "Other" },
    ];
    await expect(f.count(input)).rejects.toMatchObject({
      code: "member_filter_unavailable",
    });
    expect(
      f.context.query.mock.calls.filter(([p]) => p.endsWith("/filter")),
    ).toHaveLength(1);
  });

  it.each([
    ["before", "lessThanEqualToEndOfDay"],
    ["on", "onDay"],
    ["after", "greaterThanEqualToBeginOfDay"],
  ] as const)(
    "compiles strict subscription %s with selected scope and an explicit leap-day date",
    async (operator, native) => {
      const f = countFixture();
      f.catalog.groupID = "102";
      await f.count({
        groupName: "Choir",
        criteria: expression([criterion("subscribed", operator, "2024-02-29")]),
      });
      const form = new URLSearchParams(f.context.query.mock.calls[1]?.[1]);
      expect(form.get("request[and][0][or][0][and][0][inputs][groupID]")).toBe(
        "102",
      );
      expect(
        form.get("request[and][0][or][0][and][0][inputs][dateQueryType]"),
      ).toBe(native);
      expect(form.get("request[and][0][or][0][and][0][inputs][date]")).toBe(
        "2024-02-29",
      );
    },
  );

  it("keeps inclusive subscription dates as two alternatives, not adjusted dates", async () => {
    const f = countFixture();
    await f.count({
      criteria: expression(
        [criterion("subscribed", "before", "2026-11-04")],
        [criterion("subscribed", "on", "2026-11-04")],
      ),
    });
    const form = new URLSearchParams(f.context.query.mock.calls[1]?.[1]);
    expect(
      form.get("request[and][0][or][1][and][0][inputs][dateQueryType]"),
    ).toBe("onDay");
    expect(form.get("request[and][0][or][1][and][0][inputs][date]")).toBe(
      "2026-11-04",
    );
  });

  it.each([
    criterion("email", "mobile"),
    criterion("email_updated", "before", "2026-11-04", true),
    criterion("phone_updated", "on", "2026-11-04", true),
    criterion("email_updated", "contains", "2026-11-04"),
    criterion("phone", "contains", "555", true),
    criterion("membership", "in_group", "101"),
    criterion("membership", "in_group", "103"),
    criterion("custom:201:select:501", "equals", "999"),
    criterion("unknown", "exists"),
  ])("refuses unavailable criteria without filtering: %j", async (p) => {
    const f = countFixture();
    await expect(f.count({ criteria: expression([p]) })).rejects.toMatchObject({
      code: "member_filter_unavailable",
    });
    expect(f.context.query.mock.calls).toHaveLength(1);
  });

  it("refuses inactive inclusion unless explicitly allowed and never downgrades", async () => {
    const f = countFixture();
    await expect(
      f.count({ searchTerm: "Alex", includeInactive: true }),
    ).rejects.toMatchObject({ code: "permission_denied" });
    expect(f.context.query).toHaveBeenCalledTimes(1);
    f.catalog.canViewInactiveMembers = true;
    expect(
      await f.count({ searchTerm: "Alex", includeInactive: true }),
    ).toMatchObject({ includeInactive: true });
    expect(
      new URLSearchParams(f.context.query.mock.calls[2]?.[1]).get(
        "includeInactive",
      ),
    ).toBe("true");
  });

  it.each([
    {},
    { fields: [] },
    { limit: 1 },
    { continuation: {} },
    { mode: "members" },
    { mode: null },
    { criteria: { any: [] } },
    { criteria: { any: [{ all: [] }] } },
    {
      criteria: {
        any: [{ all: [{ fieldId: "phone", operator: "exists", nativeId: 7 }] }],
      },
    },
    { criteria: expression([criterion("phone", "exists", "unwanted")]) },
    { criteria: expression([criterion("phone", "contains", "\u0000secret")]) },
    { criteria: expression([criterion("phone", "contains", "\udfff")]) },
    {
      criteria: expression(
        ...Array.from({ length: 9 }, () => [criterion("phone", "exists")]),
      ),
    },
    {
      criteria: expression(
        Array.from({ length: 21 }, () => criterion("phone", "exists")),
      ),
    },
    ...[
      "2025-02-29",
      "1900-02-29",
      "0000-01-01",
      "2026-04-31",
      "2026-00-01",
      "2026-11-00",
      "2026-1-01",
    ].flatMap((date) =>
      ["subscribed", "email_updated", "phone_updated"].map((fieldId) => ({
        criteria: expression([criterion(fieldId, "on", date)]),
      })),
    ),
  ])("rejects invalid advanced intent before I/O: %j", async (input) => {
    const f = countFixture();
    await expect(async () =>
      new MemberSearch({ mode: "count", ...input } as MemberSearchInput).find(
        f.context,
        new Network("example-parish"),
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(f.context.query).not.toHaveBeenCalled();
  });

  it("accepts grammar boundaries but rejects oversized UTF-8 requests before discovery", async () => {
    const f = countFixture();
    await f.count({
      criteria: expression(
        Array.from({ length: 13 }, () => criterion("phone", "exists")),
        ...Array.from({ length: 7 }, () => [criterion("phone", "exists")]),
      ),
    });
    const query = {
      mode: "count" as const,
      criteria: expression(
        Array.from({ length: 20 }, () =>
          criterion("first_name", "contains", "界".repeat(256)),
        ),
      ),
    };
    expect(() => new MemberSearch(query)).toThrow(
      expect.objectContaining({
        code: "invalid_input",
        reason: "request_too_large",
      }),
    );
    const privateSearch = new MemberSearch({
      mode: "count",
      criteria: expression([
        criterion("first_name", "contains", "sensitive-query"),
      ]),
    });
    expect(
      inspect(privateSearch) + JSON.stringify(privateSearch),
    ).not.toContain("sensitive-query");
  });

  it.each([
    { results: {} },
    { results: Array(101).fill({}) },
    { resultCount: -1 },
    { resultCount: 0 },
    { resultCount: 1.5 },
    { resultCount: Infinity },
    { resultCount: Number.MAX_SAFE_INTEGER + 1 },
    { groupID: "999" },
    { includeContacts: true },
  ])(
    "rejects malformed count envelopes without echoing rows or retrying: %j",
    async (override) => {
      const f = countFixture();
      Object.assign(f.data, override);
      await expect(f.count()).rejects.toMatchObject({
        code: "invalid_response",
      });
      expect(f.context.query).toHaveBeenCalledTimes(2);
    },
  );
});

describe.each(["count", "members"] as const)(
  "contact-update dates in %s mode",
  (mode) => {
    // Fictional update facts on either side of a leap day, with different missing
    // contacts. Native response membership below encodes the characterized strict
    // boundaries independently of the compiler and these expected-date comparisons.
    const facts = [
      { id: 301, email_updated: "2024-02-28", phone_updated: "2024-03-01" },
      { id: 302, email_updated: "2024-02-29", phone_updated: null },
      { id: 303, email_updated: "2024-03-01", phone_updated: "2024-02-28" },
      { id: 304, email_updated: null, phone_updated: "2024-02-29" },
      { id: 305, email_updated: "2024-02-29", phone_updated: null },
      { id: 306, email_updated: "2024-02-28", phone_updated: "2024-02-29" },
      { id: 307, email_updated: "2024-02-28", phone_updated: "2024-03-01" },
      { id: 308, email_updated: "2024-02-28", phone_updated: "2024-03-01" },
    ];
    const responses: Record<string, Record<string, number[]>> = {
      email_updated: {
        lessThanEqualToEndOfDay: [301, 306, 307, 308],
        onDay: [302, 305],
        greaterThanEqualToBeginOfDay: [303],
      },
      phone_updated: {
        lessThanEqualToEndOfDay: [303],
        onDay: [304, 306],
        greaterThanEqualToBeginOfDay: [301, 307, 308],
      },
    };
    it.each(["email_updated", "phone_updated"] as const)(
      "maps %s boundaries, missing contacts and mixed criteria",
      async (fieldId) => {
        const f = countFixture();
        const category =
          fieldId === "email_updated" ? "Email Address" : "Phone Number";
        const definition =
          f.catalog.peopleFilterInfo.filters["Contact Info"].categories[
            category
          ].filters.at(-1)!;
        definition.filterID = fieldId === "email_updated" ? 731 : 849;
        f.context.query.mockImplementation(async (path, body) => {
          if (path.endsWith("?ajax")) return f.catalog;
          const form = new URLSearchParams(body);
          const prefix = "request[and][0][or][0][and][0]";
          expect(form.get(`${prefix}[filterID]`)).toBe(
            String(definition.filterID),
          );
          expect(form.get(`${prefix}[isNegated]`)).toBe("false");
          expect(form.get(`${prefix}[inputs][date]`)).toBe("2024-02-29");
          expect(form.has(`${prefix}[inputs][groupID]`)).toBe(false);
          const ids =
            responses[fieldId]![form.get(`${prefix}[inputs][dateQueryType]`)!]!;
          expect(ids).toBeDefined();
          const mixed = form.has("request[and][0][or][0][and][1][filterID]");
          if (mixed)
            expect(
              form.get("request[and][0][or][0][and][1][inputs][searchTerm]"),
            ).toBe("Rivera");
          const selected = mixed ? ids.filter((id) => id !== 305) : ids;
          return {
            success: true,
            resultCount: selected.length,
            results: selected.map((id) => {
              const fact = facts.find((person) => person.id === id)!;
              return {
                ...searchRow(id, "Alex", id === 305 ? "Chen" : "Rivera"),
                mail: fact.email_updated === null ? null : "alex@example.test",
                phn: fact.phone_updated === null ? null : "+12025550123",
              };
            }),
          };
        });
        for (const operator of ["before", "on", "after"] as const) {
          for (const mixed of [false, true]) {
            const expected = facts.filter((fact) => {
              const date = fact[fieldId];
              return (
                date !== null &&
                (!mixed || fact.id !== 305) &&
                (operator === "before"
                  ? date < "2024-02-29"
                  : operator === "after"
                    ? date > "2024-02-29"
                    : date === "2024-02-29")
              );
            });
            const result = await new MemberSearch({
              mode,
              criteria: expression([
                criterion(fieldId, operator, "2024-02-29"),
                ...(mixed
                  ? [criterion("last_name", "contains", "Rivera")]
                  : []),
              ]),
            }).find(f.context, new Network("example-parish"), {
              connectionGeneration: "contact-dates",
            });
            expect(result.resultCount).toBe(expected.length);
            expect(
              "criteriaSummary" in result &&
                result.criteriaSummary.any[0]?.all[0],
            ).toMatchObject({
              fieldId,
              displayName:
                fieldId === "email_updated"
                  ? "Email last updated"
                  : "Phone last updated",
              operator,
              value: "2024-02-29",
              missingValueBehavior: "excluded",
            });
            if (mode === "members")
              expect(
                "members" in result &&
                  result.members.map((member) => member.id),
              ).toEqual(expected.map((fact) => String(fact.id)));
            else expect(result).not.toHaveProperty("members");
            expect(JSON.stringify(result)).not.toMatch(
              /example.test|mobilePhone|joinedOn|exactMatchUserId/,
            );
          }
        }
        expect(f.context.query).toHaveBeenCalledTimes(12);
      },
    );

    it.each(["email_updated", "phone_updated"] as const)(
      "refuses malformed, denied or unverified %s relations before filtering",
      async (fieldId) => {
        for (const problem of [
          "permission",
          "inputs",
          "operators",
          "negation",
        ]) {
          const f = countFixture();
          const category =
            fieldId === "email_updated" ? "Email Address" : "Phone Number";
          const definition =
            f.catalog.peopleFilterInfo.filters["Contact Info"].categories[
              category
            ].filters.at(-1)!;
          if (problem === "permission")
            definition.permissions = { isOnlySuperAdmins: true };
          if (problem === "negation") definition.operatorNegated = "Not on";
          if (problem === "inputs") definition.inputs.date!.dataType = "text";
          if (problem === "operators")
            definition.inputs.dateQueryType!.allowedValues = [
              { value: "unknown", label: "Unknown" },
            ];
          await expect(
            new MemberSearch({
              mode,
              criteria: expression([
                criterion(fieldId, "on", "2024-02-29", problem === "negation"),
              ]),
            }).find(f.context, new Network("example-parish"), {
              connectionGeneration: "contact-dates",
            }),
          ).rejects.toMatchObject({
            code:
              problem === "permission" || problem === "negation"
                ? "member_filter_unavailable"
                : "invalid_response",
          });
          expect(f.context.query).toHaveBeenCalledTimes(1);
        }
      },
    );

    it("rejects invalid contact dates before I/O", async () => {
      const f = countFixture();
      for (const fieldId of ["email_updated", "phone_updated"])
        for (const value of [
          "2025-02-29",
          "1900-02-29",
          "2024-02-30",
          "2024-02-29T00:00:00Z",
        ])
          await expect(async () =>
            new MemberSearch({
              mode,
              criteria: expression([criterion(fieldId, "on", value)]),
            }).find(f.context, new Network("example-parish"), {
              connectionGeneration: "contact-dates",
            }),
          ).rejects.toMatchObject({ code: "invalid_input" });
      expect(f.context.query).not.toHaveBeenCalled();
      expect(f.context.read).not.toHaveBeenCalled();
    });
  },
);

describe("advanced member pages", () => {
  function pages(total = 237) {
    const f = countFixture();
    const state = {
      total,
      generation: "connection-one",
      parish: "example-parish",
      override: undefined as unknown[] | undefined,
    };
    const rows = Array.from({ length: 237 }, (_, i) => searchRow(1001 + i));
    f.context.query.mockImplementation(async (path, body) => {
      if (path.endsWith("?ajax")) return f.catalog;
      const offset = Number(new URLSearchParams(body).get("from"));
      return {
        ...f.data,
        results:
          state.override ??
          rows.slice(offset, Math.min(offset + 100, state.total)),
        resultCount: state.total,
      };
    });
    const page = (input: MemberSearchInput = {}) =>
      new MemberSearch({
        searchTerm: "Alex",
        groupId: "101",
        ...input,
        mode: "members" as const,
      }).find(f.context, new Network(state.parish), {
        connectionGeneration: state.generation,
      });
    return { ...f, state, rows, page };
  }

  it.each(["email_updated", "phone_updated"] as const)(
    "rejects continuation after the referenced %s native ID changes",
    async (fieldId) => {
      const f = pages();
      const criteria = expression([criterion(fieldId, "on", "2024-02-29")]);
      const first = await f.page({ criteria });
      expect(first.nextContinuation).not.toBeNull();
      const category =
        fieldId === "email_updated" ? "Email Address" : "Phone Number";
      f.catalog.peopleFilterInfo.filters["Contact Info"].categories[
        category
      ].filters.at(-1)!.filterID = 876;
      await expect(
        f.page({ criteria, continuation: first.nextContinuation! }),
      ).rejects.toMatchObject({ code: "member_search_changed" });
      expect(
        f.context.query.mock.calls.filter(([path]) => path.endsWith("/filter")),
      ).toHaveLength(1);
    },
  );

  it.each([
    [237, 100],
    [200, 100],
    [237, 37],
    [3, 1],
    [17, 100],
    [0, 100],
  ])(
    "returns every reported row without skips (total %i, limit %i)",
    async (total, limit) => {
      const f = pages(total);
      const ids: string[] = [];
      let continuation: MemberSearchContinuation | undefined;
      const offsets: number[] = [];
      do {
        const result = await f.page({
          limit,
          ...(continuation ? { continuation } : {}),
        });
        offsets.push(result.offset);
        expect(result.offset).toBe(ids.length);
        expect(result.complete).toBe(result.offset === 0 && total <= limit);
        expect(result.returnedCount).toBe(Math.min(limit, total - ids.length));
        expect(
          result.members.every(
            (m) => Object.keys(m).sort().join(",") === "firstName,id,lastName",
          ),
        ).toBe(true);
        expect(result).not.toHaveProperty("exactMatchUserId");
        ids.push(...result.members.map((m) => m.id));
        expect(result.hasMore).toBe(ids.length < total);
        if (result.nextContinuation) {
          expect(Object.keys(result.nextContinuation).sort()).toEqual([
            "offset",
            "previousPageKey",
            "queryKey",
            "resultCount",
          ]);
          expect(result.nextContinuation.queryKey).toMatch(/^[a-f0-9]{64}$/);
          expect(result.nextContinuation.previousPageKey).toBe(
            createHash("sha256")
              .update(JSON.stringify(result.members.map((m) => m.id)))
              .digest("hex"),
          );
        }
        continuation = result.nextContinuation ?? undefined;
      } while (continuation);
      expect(ids).toEqual(
        Array.from({ length: total }, (_, i) => String(1001 + i)),
      );
      const queries = f.context.query.mock.calls.filter(([path]) =>
        path.endsWith("/filter"),
      );
      expect(
        queries.map(([, body]) =>
          Number(new URLSearchParams(body).get("from")),
        ),
      ).toEqual(offsets);
      expect(f.context.query).toHaveBeenCalledTimes(offsets.length * 2);
    },
  );

  it("selects contacts only on request and never resolves an advanced identity", async () => {
    const f = pages(1);
    expect((await f.page()).members[0]).not.toHaveProperty("email");
    const result = await f.page({
      fields: ["email", "mobilePhone", "joinedOn"],
    });
    expect(result.members[0]).toMatchObject({
      email: { value: "alex@example.test", verified: false },
      mobilePhone: { verified: true },
      joinedOn: "2026-03-05",
    });
    expect(result).not.toHaveProperty("exactMatchUserId");
  });

  it.each([
    { searchTerm: "different" },
    { fields: ["email"] },
    { limit: 99 },
    { includeInactive: true },
    { criteria: expression([criterion("phone", "exists")]) },
  ] as MemberSearchInput[])(
    "rejects a changed query before filtering: %j",
    async (change) => {
      const f = pages();
      f.catalog.canViewInactiveMembers = true;
      const first = await f.page();
      f.context.query.mockClear();
      await expect(
        f.page({ ...change, continuation: first.nextContinuation! }),
      ).rejects.toMatchObject({ code: "member_search_changed" });
      expect(f.context.query).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["generation", "parish", "group", "catalog"])(
    "binds continuation to %s",
    async (change) => {
      const f = pages();
      const first = await f.page();
      if (change === "generation") f.state.generation = "connection-two";
      if (change === "parish") f.state.parish = "another-parish";
      if (change === "group") f.catalog.groupID = "102";
      if (change === "catalog")
        f.catalog.peopleFilterInfo.generalSearchFilter.filterID = 99;
      f.context.query.mockClear();
      await expect(
        f.page({
          groupId: change === "group" ? "102" : "101",
          continuation: first.nextContinuation!,
        }),
      ).rejects.toMatchObject({ code: "member_search_changed" });
      expect(f.context.query).toHaveBeenCalledTimes(1);
    },
  );

  it("binds referenced custom definitions and rechecks permissions", async () => {
    const f = pages();
    const criteria = expression([
      criterion("custom:201:select:501", "equals", "1"),
    ]);
    const first = await f.page({ criteria });
    const choices = f.catalog.peopleFilterInfo.filters;
    // The fixture deliberately shares native filter IDs across custom fields.
    const custom = choices["Personal Info"].categories.ChoiceA;
    const equals = custom.filters.find(
      (d) => d.filterName === "Select List Field Equals",
    )!;
    const input = equals.inputs as Record<string, { allowedValues: unknown }>;
    input.listOfIDs!.allowedValues = [
      { value: 1, label: "Changed label" },
      { value: 2, label: "Same label" },
    ];
    await expect(
      f.page({ criteria, continuation: first.nextContinuation! }),
    ).rejects.toMatchObject({ code: "member_search_changed" });
    f.catalog.canViewInactiveMembers = true;
    const active = await f.page({ includeInactive: true });
    f.catalog.canViewInactiveMembers = false;
    await expect(
      f.page({ includeInactive: true, continuation: active.nextContinuation! }),
    ).rejects.toMatchObject({ code: "permission_denied" });
  });

  it("stops changed totals, repeated pages and empty premature pages without replay", async () => {
    const f = pages();
    const first = await f.page();
    f.state.total = 236;
    await expect(
      f.page({ continuation: first.nextContinuation! }),
    ).rejects.toMatchObject({ code: "member_search_changed" });
    f.state.total = 237;
    f.state.override = f.rows
      .slice(0, 100)
      .map((r) => ({ ...r, mail: "changed@example.test" }));
    await expect(
      f.page({ continuation: first.nextContinuation! }),
    ).rejects.toMatchObject({ code: "member_search_incomplete" });
    f.state.override = [];
    await expect(
      f.page({ continuation: first.nextContinuation! }),
    ).rejects.toMatchObject({ code: "member_search_incomplete" });
    await expect(f.page()).rejects.toMatchObject({
      code: "member_search_incomplete",
    });
    expect(
      f.context.query.mock.calls.filter(([p]) => p.endsWith("/filter")),
    ).toHaveLength(5);
    const end = await f.page({
      continuation: { ...first.nextContinuation!, offset: 237 },
    });
    expect(end).toMatchObject({
      offset: 237,
      members: [],
      hasMore: false,
      nextContinuation: null,
      complete: false,
    });
  });

  it.each([
    { offset: -1 },
    { offset: 1.5 },
    { offset: Number.MAX_SAFE_INTEGER + 1 },
    { resultCount: -1 },
    { offset: 238 },
    { queryKey: "A".repeat(64) },
    { previousPageKey: "bad" },
    { extra: "private" },
  ])("rejects malformed continuation before discovery: %j", async (change) => {
    const f = pages();
    const first = await f.page();
    f.context.query.mockClear();
    await expect(async () =>
      f.page({ continuation: { ...first.nextContinuation!, ...change } }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(f.context.query).not.toHaveBeenCalled();
  });

  it("rejects modified hashes, keeps cursors private and snapshots caller input", async () => {
    const f = pages();
    const first = await f.page();
    const token = { ...first.nextContinuation! };
    const search = new MemberSearch({
      mode: "members",
      searchTerm: "Alex",
      groupId: "101",
      continuation: token,
    });
    token.queryKey = "a".repeat(64);
    expect(JSON.stringify(search) + inspect(search)).not.toMatch(
      /Alex|queryKey|previousPageKey/,
    );
    expect(
      (
        await search.find(f.context, new Network(f.state.parish), {
          connectionGeneration: f.state.generation,
        })
      ).offset,
    ).toBe(100);
    await expect(f.page({ continuation: token })).rejects.toMatchObject({
      code: "member_search_changed",
    });
  });

  it.each([
    {
      results: [searchRow(1001), searchRow(1001)],
      reason: "duplicate_identifier",
    },
    {
      results: [searchRow(1001), { ...searchRow(1002), fn: "", ln: "" }],
      reason: "missing_name",
    },
    {
      results: [{ ...searchRow(), userID: "../private" }],
      reason: "expected_identifier",
    },
    {
      results: Array.from({ length: 101 }, (_, i) => searchRow(1001 + i)),
      reason: "page_limit_exceeded",
    },
  ])(
    "validates all native identities before truncating: $reason",
    async ({ results, reason }) => {
      const f = pages();
      f.state.override = results;
      await expect(f.page({ limit: 1 })).rejects.toMatchObject({
        code: "invalid_response",
        reason,
      });
    },
  );

  it("guards total/offset arithmetic and preserves cancellation", async () => {
    const f = pages();
    const first = await f.page();
    f.state.total = Number.MAX_SAFE_INTEGER;
    f.state.override = [searchRow()];
    await expect(
      f.page({
        continuation: {
          ...first.nextContinuation!,
          offset: Number.MAX_SAFE_INTEGER,
          resultCount: Number.MAX_SAFE_INTEGER,
        },
      }),
    ).rejects.toMatchObject({
      code: "invalid_response",
      reason: "invalid_result_count",
    });
    f.context.query.mockClear();
    f.context.check.mockImplementation(() => {
      throw new FlockbotError("operation_cancelled");
    });
    await expect(
      f.page({ continuation: first.nextContinuation! }),
    ).rejects.toMatchObject({ code: "operation_cancelled" });
    expect(f.context.query).not.toHaveBeenCalled();
  });
});

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
