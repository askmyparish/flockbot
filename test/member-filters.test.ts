import { inspect } from "node:util";
import { describe, expect, it, vi } from "vitest";
import {
  MemberFilters,
  type MemberFiltersInput,
} from "../src/models/member-filters.js";
import { Network } from "../src/models/network.js";
import { FlockbotError } from "../src/errors.js";
import { filterCatalog, selectCategory } from "./fixtures/member-filters.js";

function fixture() {
  const data = filterCatalog();
  const context = {
    check: vi.fn(),
    read: vi.fn(async (path: string): Promise<unknown> => {
      if (path === "dashboard") return '<div id="fnReactHolder"></div>';
      if (path === "navigation/groups")
        return { groups: [{ ID: 102, name: "Choir", shortname: "choir" }] };
      return { everyoneGroupID: 101 };
    }),
    query: vi.fn(
      async (_path: string, _body?: string): Promise<unknown> => data,
    ),
  };
  const read = (input: MemberFiltersInput = {}) =>
    new MemberFilters(input).read(context, new Network("example-parish"));
  return { data, context, read };
}
describe("member filter discovery", () => {
  it("discovers Everyone and exposes supported descriptors with characterized contact dates", async () => {
    const f = fixture();
    for (const category of ["Email Address", "Phone Number"] as const)
      f.data.peopleFilterInfo.filters["Contact Info"].categories[
        category
      ].filters.at(-1)!.operatorNegated = "Not on";
    const result = await f.read();
    expect(result).toMatchObject({
      groupId: "101",
      includeInactive: false,
      total: 10,
      offset: 0,
      hasMore: false,
      nextOffset: null,
    });
    expect(result.fields?.map((x) => x.fieldId)).toEqual([
      "custom:201:select:501",
      "custom:202:select:502",
      "email",
      "email_updated",
      "first_name",
      "last_name",
      "membership",
      "phone",
      "phone_updated",
      "subscribed",
    ]);
    expect(
      result.fields
        ?.find((x) => x.fieldId === "email")
        ?.operators.map((x) => x.operator),
    ).toEqual(["exists", "contains", "verified", "bad", "not_bad"]);
    expect(
      result.fields?.find((x) => x.fieldId === "phone")?.operators,
    ).toContainEqual({
      operator: "verified",
      negation: true,
      missingValueBehavior: "excluded",
    });
    for (const fieldId of ["email_updated", "phone_updated"])
      expect(result.fields?.find((x) => x.fieldId === fieldId)).toMatchObject({
        available: true,
        type: "date",
        operators: ["before", "on", "after"].map((operator) => ({
          operator,
          negation: false,
          missingValueBehavior: "excluded",
        })),
      });
    expect(JSON.stringify(result)).not.toMatch(
      /alex@|Rivera|555|<script|private-|https:|permissions|filterID|subscribedMembers/,
    );
    expect(f.context.query.mock.calls).toEqual([
      ["group/101/people?ajax", "includeUnsubscribed=0"],
    ]);
  });
  it("keeps repeated native IDs and duplicate labels distinct, refreshing choices each call", async () => {
    const f = fixture();
    const a = await f.read({
      groupId: "101",
      fieldId: "custom:201:select:501",
    });
    expect(a.choices).toEqual([
      { id: "1", label: "Same label" },
      { id: "2", label: "Same label" },
    ]);
    f.data.peopleFilterInfo.filters["Personal Info"].categories.ChoiceA =
      selectCategory(201, 501, 1);
    expect(
      (await f.read({ groupId: "101", fieldId: "custom:201:select:501" }))
        .total,
    ).toBe(1);
    expect(
      (await f.read({ groupId: "101", fieldId: "custom:202:select:502" }))
        .total,
    ).toBe(2);
    f.data.peopleFilterInfo.filters["Personal Info"].categories.ChoiceA =
      selectCategory(201, 504, 1);
    await expect(
      f.read({ groupId: "101", fieldId: "custom:201:select:501" }),
    ).rejects.toMatchObject({ code: "member_filter_unavailable" });
    expect(f.context.query).toHaveBeenCalledTimes(4);
    expect(f.context.read).not.toHaveBeenCalled();
  });
  it("bounds both descriptor and choice pages without losing the boundary item", async () => {
    const f = fixture();
    Object.assign(
      f.data.peopleFilterInfo.filters["Personal Info"].categories,
      Object.fromEntries(
        Array.from({ length: 43 }, (_, i) => [
          `F${i}`,
          selectCategory(300 + i, 600 + i),
        ]),
      ),
    );
    const first = await f.read({ groupId: "101" });
    const last = await f.read({ groupId: "101", offset: 50 });
    expect(first).toMatchObject({ total: 53, hasMore: true, nextOffset: 50 });
    expect(first.fields).toHaveLength(50);
    expect(last.fields).toHaveLength(3);
    expect(
      new Set([...first.fields!, ...last.fields!].map((x) => x.fieldId)).size,
    ).toBe(53);
    f.data.peopleFilterInfo.filters["Personal Info"].categories.ChoiceA =
      selectCategory(201, 501, 51);
    const choices = await f.read({
      groupId: "101",
      fieldId: "custom:201:select:501",
    });
    expect(choices).toMatchObject({ total: 51, hasMore: true, nextOffset: 50 });
    expect(choices.choices).toHaveLength(50);
    expect(
      await f.read({
        groupId: "101",
        fieldId: "custom:201:select:501",
        offset: 50,
      }),
    ).toMatchObject({
      choices: [{ id: "51", label: "Option 51" }],
      hasMore: false,
      nextOffset: null,
    });
    expect(
      (
        await f.read({
          groupId: "101",
          fieldId: "custom:201:select:501",
          offset: 51,
        })
      ).choices,
    ).toEqual([]);
    await expect(f.read({ groupId: "101", offset: 54 })).rejects.toMatchObject({
      code: "invalid_input",
    });
  });
  it("resolves group names, reports inactive capability and excludes disabled/smart choices", async () => {
    const f = fixture();
    f.data.groupID = "102";
    f.data.isEveryoneGroup = 0;
    f.data.canViewInactiveMembers = true;
    expect(
      await f.read({ groupName: " CHOIR ", fieldId: "membership" }),
    ).toMatchObject({
      groupId: "102",
      includeInactive: true,
      choices: [{ id: "102", label: "Choir" }],
    });
    expect(f.context.query.mock.calls[0]?.[0]).toBe("group/102/people?ajax");
  });
  it("does not infer unavailable group scope", async () => {
    const f = fixture();
    f.context.read.mockImplementation(async (path) =>
      path === "dashboard"
        ? '<div id="fnReactHolder"></div>'
        : path === "navigation/groups"
          ? {
              groups: [
                { ID: 102, name: "Choir", shortname: "a" },
                { ID: 103, name: "CHOIR", shortname: "b" },
              ],
            }
          : { everyoneGroupID: null },
    );
    await expect(f.read()).rejects.toMatchObject({
      code: "everyone_not_found",
    });
    await expect(f.read({ groupName: "choir" })).rejects.toMatchObject({
      code: "group_ambiguous",
    });
    expect(f.context.query).not.toHaveBeenCalled();
  });
  it.each([
    {},
    { isOnlySuperAdmins: true },
    { requiredNetworkFeatureDictID: 23 },
    { isOnlyEveryoneGroup: true },
    { unknownPermission: true },
  ])(
    "does not treat catalog visibility as permission: %j",
    async (restriction) => {
      const f = fixture();
      f.data.isEveryoneGroup = 0;
      const filter =
        f.data.peopleFilterInfo.filters["Personal Info"].categories.ChoiceA
          .filters[0]!;
      filter.permissions = restriction;
      // An absent permission declaration is unsupported, never an access grant.
      expect(
        (await f.read({ groupId: "101" })).fields?.find(
          (x) => x.fieldId === "custom:201:select:501",
        )?.available,
      ).toBe(false);
      await expect(
        f.read({ groupId: "101", fieldId: "custom:201:select:501" }),
      ).rejects.toMatchObject({
        code: Object.keys(restriction).length
          ? "member_filter_unavailable"
          : "invalid_response",
      });
    },
  );
  it.each([
    "<b>label</b>",
    "x".repeat(257),
    "\udfff",
    "https://example.test/private",
  ])(
    "withholds malformed labels rather than truncating them",
    async (label) => {
      const f = fixture();
      f.data.peopleFilterInfo.filters[
        "Personal Info"
      ].categories.ChoiceA.displayName = label;
      const result = await f.read({ groupId: "101" });
      expect(result.fields?.[0]).toMatchObject({
        displayName: "Unavailable custom field",
        available: false,
      });
      await expect(
        f.read({ groupId: "101", fieldId: "custom:201:select:501" }),
      ).rejects.toMatchObject({
        code: "invalid_response",
        reason: "search_filter_label",
      });
      expect(JSON.stringify(result)).not.toContain(label);
    },
  );
  it.each([
    { displayName: 123 },
    { displayName: "" },
    { operatorNegated: null },
  ])(
    "distinguishes malformed label metadata from unsafe content: %j",
    async (malformed) => {
      const f = fixture();
      const category =
        f.data.peopleFilterInfo.filters["Personal Info"].categories.ChoiceA;
      if ("displayName" in malformed) Object.assign(category, malformed);
      else Object.assign(category.filters[0]!, malformed);
      expect(
        (await f.read({ groupId: "101" })).fields?.find(
          (x) => x.fieldId === "custom:201:select:501",
        ),
      ).toMatchObject({
        available: false,
        unavailableReason: "unsupported_definition",
      });
      await expect(
        f.read({ groupId: "101", fieldId: "custom:201:select:501" }),
      ).rejects.toMatchObject({
        code: "invalid_response",
        reason: "search_filter_shape",
      });
    },
  );
  it("rejects mismatched fixed metadata and duplicate choice identities", async () => {
    const f = fixture();
    const category =
      f.data.peopleFilterInfo.filters["Personal Info"].categories.ChoiceA;
    category.filters[1]!.inputs.networkFieldID!.allowedValues = 999;
    await expect(
      f.read({ groupId: "101", fieldId: "custom:201:select:501" }),
    ).rejects.toMatchObject({ code: "invalid_response" });
    category.filters[1]!.inputs.networkFieldID!.allowedValues = 201;
    category.filters[1]!.inputs.listOfIDs!.allowedValues = [
      { value: 1, label: "A" },
      { value: 1, label: "B" },
    ];
    await expect(
      f.read({ groupId: "101", fieldId: "custom:201:select:501" }),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });
  it.each([
    [
      { groupID: "999" },
      { code: "invalid_response", reason: "group_identity_mismatch" },
    ],
    [
      { groupID: undefined },
      { code: "invalid_response", reason: "expected_text" },
    ],
    [
      { includeContacts: true },
      { code: "invalid_response", reason: "contacts_included" },
    ],
    [
      { includeContacts: undefined },
      { code: "invalid_response", reason: "contacts_included" },
    ],
    [
      { canViewInactiveMembers: null },
      { code: "invalid_response", reason: "expected_flag" },
    ],
    [
      { canViewInactiveMembers: undefined },
      { code: "invalid_response", reason: "expected_flag" },
    ],
    [
      { isEveryoneGroup: undefined },
      { code: "invalid_response", reason: "expected_flag" },
    ],
    [{ canView: false }, { code: "permission_denied" }],
    [
      { success: false },
      { code: "upstream_rejected", reason: "success_false" },
    ],
  ])("rejects unsafe envelopes %j", async (change, error) => {
    const f = fixture();
    Object.assign(f.data, change);
    await expect(f.read({ groupId: "101" })).rejects.toMatchObject(error);
  });
  it.each([501, 502])(
    "isolates conflicting custom identities from unrelated fields (instance %s)",
    async (instance) => {
      const f = fixture();
      f.data.peopleFilterInfo.filters["Personal Info"].categories.ChoiceB =
        selectCategory(201, instance);
      expect(
        (await f.read({ groupId: "101", fieldId: "first_name" })).field
          ?.available,
      ).toBe(true);
      const fields = (await f.read({ groupId: "101" })).fields!;
      expect(new Set(fields.map((x) => x.fieldId)).size).toBe(fields.length);
      expect(
        fields.find((x) => x.fieldId === "custom:201:select:501"),
      ).toMatchObject({
        available: false,
        operators: [],
        unavailableReason: "unsupported_definition",
      });
      await expect(
        f.read({ groupId: "101", fieldId: "custom:201:select:501" }),
      ).rejects.toMatchObject({
        code: "invalid_response",
        reason: "search_filter_shape",
      });
    },
  );
  it.each(["membership", "custom:201:select:501"])(
    "reports unsafe choice labels without leaking them: %s",
    async (fieldId) => {
      const f = fixture(),
        label = "https://private.example.test/choice";
      const filters = f.data.peopleFilterInfo.filters;
      if (fieldId === "membership")
        filters.Groups.categories["In Other Groups"].filters[0]!.inputs
          .otherGroupID!.allowedValues = [
          { value: 102, name: label, disabled: false, isSmartGroup: false },
        ];
      else
        filters["Personal Info"].categories.ChoiceA.filters[1]!.inputs
          .listOfIDs!.allowedValues = [{ value: 1, label }];
      const result = await f.read({ groupId: "101" });
      expect(result.fields?.find((x) => x.fieldId === fieldId)).toMatchObject({
        available: false,
        unavailableReason: "unsafe_label",
        operators: [],
      });
      expect(JSON.stringify(result)).not.toContain(label);
      await expect(f.read({ groupId: "101", fieldId })).rejects.toMatchObject({
        code: "invalid_response",
        reason: "search_filter_label",
      });
    },
  );
  it.each(["permission", "shape", "duplicate", "date"])(
    "withholds only the affected builtin on %s",
    async (problem) => {
      const f = fixture();
      const first =
        f.data.peopleFilterInfo.filters["Personal Info"].categories[
          "First Name"
        ].filters;
      if (problem === "permission")
        first[0]!.permissions = { isOnlySuperAdmins: true };
      if (problem === "shape") first[0]!.operator = "Unknown";
      if (problem === "duplicate") first.push(structuredClone(first[0]!));
      if (problem === "date")
        f.data.peopleFilterInfo.filters.Groups.categories["Date Joined"]
          .filters[0]!.inputs.dateQueryType!.allowedValues = [
          { value: "unknown", label: "unknown" },
        ];
      const fieldId = problem === "date" ? "subscribed" : "first_name";
      const result = await f.read({ groupId: "101" });
      expect(result.fields?.find((x) => x.fieldId === fieldId)).toMatchObject({
        available: false,
        operators: [],
      });
      expect(
        result.fields?.find((x) => x.fieldId === "last_name")?.available,
      ).toBe(true);
      await expect(f.read({ groupId: "101", fieldId })).rejects.toMatchObject(
        problem === "permission"
          ? { code: "member_filter_unavailable" }
          : { code: "invalid_response", reason: "search_filter_shape" },
      );
    },
  );
  it("accepts empty native input arrays and Everyone-only capabilities in their scope", async () => {
    const f = fixture();
    const first =
      f.data.peopleFilterInfo.filters["Personal Info"].categories["First Name"]
        .filters[0]!;
    Object.assign(first, {
      inputs: [],
      permissions: { isOnlyEveryoneGroup: true },
    });
    expect(
      (await f.read({ groupId: "101", fieldId: "first_name" })).field
        ?.operators,
    ).toContainEqual({
      operator: "exists",
      negation: true,
      missingValueBehavior: "native_unknown",
    });
  });
  it.each([
    { groupId: "101", groupName: "Choir" },
    { offset: -1 },
    { offset: 1.2 },
    { offset: Number.MAX_SAFE_INTEGER },
    { offset: null },
    { fieldId: "../private" },
    { groupId: "0" },
    { url: "https://example.test" },
  ])("rejects invalid input before reads %j", async (input) => {
    const f = fixture();
    await expect(async () =>
      f.read(input as MemberFiltersInput),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(f.context.query).not.toHaveBeenCalled();
  });
  it("retains transport identity and redacts inspection", async () => {
    const f = fixture(),
      error = new FlockbotError(
        "invalid_response",
        200,
        undefined,
        undefined,
        "response_too_large",
      );
    f.context.query.mockRejectedValue(error);
    await expect(f.read()).rejects.toBe(error);
    const request = new MemberFilters({ groupName: "Private group" });
    expect(inspect(request) + JSON.stringify(request)).not.toContain(
      "Private group",
    );
  });
});
