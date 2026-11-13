import { FlockbotError } from "../errors.js";
import { identifier } from "./identifier.js";
import { inputIdentifier, memberFlag } from "./member-fields.js";
import { type Network, normalizedGroupName } from "./network.js";
import { invalidResponse, record } from "./parsing.js";
import type { ResourceQuery } from "./resource-read.js";

export const MEMBER_FILTER_PAGE_SIZE = 50;
const FIELD_ID =
  /^(?:[a-z_]{1,40}|custom:[1-9]\d{0,127}:select:[1-9]\d{0,127})$/;

export const MEMBER_OPERATORS = [
  "exists",
  "contains",
  "verified",
  "bad",
  "not_bad",
  "mobile",
  "landline",
  "in_group",
  "before",
  "on",
  "after",
  "equals",
] as const;
export interface MemberPredicate {
  readonly fieldId: string;
  readonly operator: (typeof MEMBER_OPERATORS)[number];
  readonly value?: string | undefined;
  readonly negated?: boolean | undefined;
}
const OPERATOR_VALUES: Record<
  MemberPredicate["operator"],
  null | "text" | "identifier" | "date"
> = {
  exists: null,
  contains: "text",
  verified: null,
  bad: null,
  not_bad: null,
  mobile: null,
  landline: null,
  in_group: "identifier",
  equals: "identifier",
  before: "date",
  on: "date",
  after: "date",
};
const DATE_OPERATORS = new Map<MemberPredicate["operator"], string>([
  ["before", "lessThanEqualToEndOfDay"],
  ["on", "onDay"],
  ["after", "greaterThanEqualToBeginOfDay"],
]);
export interface MemberCriteria {
  readonly any: readonly { readonly all: readonly MemberPredicate[] }[];
}
export interface MemberCriteriaSummary {
  readonly groupId: string;
  readonly includeInactive: boolean;
  readonly searchTerm?: string;
  readonly any: readonly {
    readonly all: readonly (MemberPredicate & {
      readonly displayName: string;
      readonly choiceLabel?: string;
      readonly missingValueBehavior: MemberFilterOperator["missingValueBehavior"];
    })[];
  }[];
}

function inputObject(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !keys.includes(k))
  )
    throw new FlockbotError("invalid_input");
  return value as Record<string, unknown>;
}
export function memberSearchText(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 256 ||
    /[\p{Cc}\p{Cs}]/u.test(value)
  )
    throw new FlockbotError("invalid_input");
  return value.trim();
}
function calendarDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value))
    throw new FlockbotError("invalid_input");
  const [year = 0, month = 0, day = 0] = value.split("-").map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (!year || !day || day > (days[month - 1] ?? 0))
    throw new FlockbotError("invalid_input");
  return value;
}

/** Snapshot the bounded grammar before any I/O; native bindings come later. */
export function memberCriteria(value: unknown): MemberCriteria {
  const criteria = inputObject(value, ["any"]);
  if (
    !Array.isArray(criteria.any) ||
    !criteria.any.length ||
    criteria.any.length > 8
  )
    throw new FlockbotError("invalid_input");
  let count = 0;
  const any = criteria.any.map((alternative) => {
    const branch = inputObject(alternative, ["all"]);
    if (!Array.isArray(branch.all) || !branch.all.length)
      throw new FlockbotError("invalid_input");
    count += branch.all.length;
    if (count > 20) throw new FlockbotError("invalid_input");
    const all = branch.all.map((value): MemberPredicate => {
      const p = inputObject(value, ["fieldId", "operator", "value", "negated"]);
      if (
        typeof p.fieldId !== "string" ||
        !FIELD_ID.test(p.fieldId) ||
        !MEMBER_OPERATORS.includes(p.operator as MemberPredicate["operator"]) ||
        (p.negated !== undefined && typeof p.negated !== "boolean")
      )
        throw new FlockbotError("invalid_input");
      const operator = p.operator as MemberPredicate["operator"];
      const rule = OPERATOR_VALUES[operator];
      const takesValue = rule !== null;
      if (takesValue ? typeof p.value !== "string" : p.value !== undefined)
        throw new FlockbotError("invalid_input");
      let parsed: string | undefined;
      if (takesValue) {
        parsed = memberSearchText(p.value);
        if (rule === "identifier") parsed = inputIdentifier(parsed);
        else if (rule === "date") {
          if (!DATE_OPERATORS.has(operator))
            throw new FlockbotError("member_filter_unavailable");
          parsed = calendarDate(parsed);
        }
      }
      return Object.freeze({
        fieldId: p.fieldId,
        operator,
        negated: p.negated === true,
        ...(parsed === undefined ? {} : { value: parsed }),
      });
    });
    return Object.freeze({ all: Object.freeze(all) });
  });
  return Object.freeze({ any: Object.freeze(any) });
}

export interface MemberFiltersInput {
  readonly groupId?: string | undefined;
  readonly groupName?: string | undefined;
  readonly fieldId?: string | undefined;
  readonly offset?: number | undefined;
}
export interface MemberFilterOperator {
  readonly operator: string;
  readonly negation: boolean;
  readonly missingValueBehavior: "excluded" | "native_unknown";
}
export interface MemberFilterField {
  readonly fieldId: string;
  readonly displayName: string;
  readonly type: "text" | "contact" | "date" | "group" | "select";
  readonly available: boolean;
  readonly unavailableReason?:
    | "unsupported_definition"
    | "unsafe_label"
    | "permission_unverified"
    | "unverified_semantics";
  readonly operators: readonly MemberFilterOperator[];
}
export interface MemberFilterChoice {
  readonly id: string;
  readonly label: string;
}
export interface MemberFiltersResult {
  readonly groupId: string;
  readonly includeInactive: boolean;
  readonly fields?: readonly MemberFilterField[];
  readonly field?: MemberFilterField;
  readonly choices?: readonly MemberFilterChoice[];
  readonly offset: number;
  readonly total: number;
  readonly hasMore: boolean;
  readonly nextOffset: number | null;
}

type Definition = readonly [
  filterName: string,
  nativeOperator: string,
  operator: string,
  inputs: Readonly<Record<string, string>>,
];
// These semantic signatures, not native filter IDs, define supported operators.
const FIELDS: readonly {
  id: string;
  name: string;
  type: MemberFilterField["type"];
  section: string;
  category: string;
  definitions: readonly Definition[];
  unverified?: boolean;
}[] = [
  {
    id: "first_name",
    name: "First name",
    type: "text",
    section: "Personal Info",
    category: "First Name",
    definitions: [
      ["a first name", "Has", "exists", {}],
      ["first name", "Search", "contains", { searchTerm: "text" }],
    ],
  },
  {
    id: "last_name",
    name: "Last name",
    type: "text",
    section: "Personal Info",
    category: "Last Name",
    definitions: [
      ["a last name", "Has", "exists", {}],
      ["last name", "Search", "contains", { searchTerm: "text" }],
    ],
  },
  {
    id: "email",
    name: "Email",
    type: "contact",
    section: "Contact Info",
    category: "Email Address",
    definitions: [
      ["an email address", "Has", "exists", {}],
      ["email address for", "Search", "contains", { searchTerm: "text" }],
      ["Email Verification Status", "Is", "verified", {}],
      ["Email Bad", "Is", "bad", {}],
      ["Email Not Bad", "Is", "not_bad", {}],
    ],
  },
  {
    id: "phone",
    name: "Phone",
    type: "contact",
    section: "Contact Info",
    category: "Phone Number",
    definitions: [
      ["a phone number", "Has", "exists", {}],
      ["phone number for", "Search", "contains", { searchTerm: "text" }],
      ["Phone Verification Status", "Equals", "verified", {}],
      ["a mobile phone", "Is", "mobile", {}],
      ["a landline", "Is", "landline", {}],
    ],
  },
  {
    id: "email_updated",
    name: "Email last updated",
    type: "date",
    section: "Contact Info",
    category: "Email Address",
    definitions: [
      [
        "Email Last Updated",
        "Before",
        "before",
        { date: "date", dateQueryType: "text" },
      ],
    ],
  },
  {
    id: "phone_updated",
    name: "Phone last updated",
    type: "date",
    section: "Contact Info",
    category: "Phone Number",
    definitions: [
      [
        "Phone Last Updated",
        "Before",
        "before",
        { date: "date", dateQueryType: "text" },
      ],
    ],
  },
  {
    id: "membership",
    name: "Membership in another group",
    type: "group",
    section: "Groups",
    category: "In Other Groups",
    definitions: [["also in", "Is", "in_group", { otherGroupID: "keyword" }]],
  },
  {
    id: "subscribed",
    name: "Group subscription date",
    type: "date",
    section: "Groups",
    category: "Date Joined",
    definitions: [
      [
        "Subscribed",
        "Before",
        "before",
        { groupID: "keyword", dateQueryType: "text", date: "date" },
      ],
    ],
  },
];

function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim())
    return invalidResponse("search_filter_shape");
  if (
    value.length > 256 ||
    /[<>]|[\p{Cc}\p{Cs}]|https?:\/\/|www\./iu.test(value)
  )
    return invalidResponse("search_filter_label");
  return value.trim();
}
function nativeId(value: unknown): string {
  const id = identifier(value);
  if (!/^[1-9]\d{0,127}$/.test(id))
    return invalidResponse("search_filter_identifier");
  return id;
}
function inputsOf(filter: Record<string, unknown>): Record<string, unknown> {
  return Array.isArray(filter.inputs) && filter.inputs.length === 0
    ? {}
    : record(filter.inputs);
}
function definition(
  value: unknown,
  signature: Definition,
): Record<string, unknown> {
  const [filterName, nativeOperator, , expectedInputs] = signature;
  const f = record(value);
  nativeId(f.filterID);
  if (f.filterName !== filterName || f.operator !== nativeOperator)
    return invalidResponse("search_filter_shape");
  const inputs = inputsOf(f);
  if (Object.keys(inputs).length !== Object.keys(expectedInputs).length)
    return invalidResponse("search_filter_shape");
  for (const [key, type] of Object.entries(expectedInputs)) {
    const input = record(inputs[key]);
    if (
      input.inputName !== key ||
      input.dataType !== type ||
      input.allowMultiple !== false
    )
      return invalidResponse("search_filter_shape");
  }
  if (f.operatorNegated !== undefined) text(f.operatorNegated);
  return f;
}
function permitted(f: Record<string, unknown>, everyone: boolean): boolean {
  const permissions = record(f.permissions);
  if (Object.keys(permissions).length === 0)
    return invalidResponse("search_filter_shape");
  for (const [key, value] of Object.entries(permissions)) {
    if (key === "requiredNetworkFeatureDictID") {
      if (value !== null) return false;
      continue;
    }
    if (typeof value !== "boolean")
      return invalidResponse("search_filter_shape");
    if (!value) continue;
    if (
      [
        "isOnlyPeople",
        "isNotContactsView",
        "isNotHouseholdsView",
        "isNotSmartGroupFilter",
      ].includes(key)
    )
      continue;
    if (key === "isOnlyEveryoneGroup" && everyone) continue;
    return false;
  }
  return true;
}
function choices(value: unknown, group = false): MemberFilterChoice[] {
  if (!Array.isArray(value)) return invalidResponse("search_filter_shape");
  const seen = new Set<string>();
  const result: MemberFilterChoice[] = [];
  for (const item of value) {
    const row = record(item);
    const id = nativeId(row.value);
    if (seen.has(id)) return invalidResponse("search_filter_identifier");
    seen.add(id);
    if (group) {
      if (
        typeof row.disabled !== "boolean" ||
        typeof row.isSmartGroup !== "boolean"
      )
        return invalidResponse("search_filter_shape");
      if (row.disabled || row.isSmartGroup) continue;
    }
    result.push({ id, label: text(group ? row.name : row.label) });
  }
  return result;
}

type Binding = { filterID: string; fixedInputs: Record<string, string> };
type Field = {
  descriptor: MemberFilterField;
  choices: MemberFilterChoice[];
  bindings: Map<string, Binding>;
};
function builtinFields(
  sections: Record<string, unknown>,
  everyone: boolean,
): Field[] {
  const fields: Field[] = [];
  for (const config of FIELDS) {
    const section = sections[config.section];
    if (section === undefined) continue;
    const category = record(record(section).categories)[config.category];
    if (category === undefined) continue;
    const rows = record(category).filters;
    if (!Array.isArray(rows)) return invalidResponse("search_filter_shape");
    const found = config.definitions.map((signature) => ({
      signature,
      rows: rows.filter(
        (v) =>
          v &&
          typeof v === "object" &&
          (v as Record<string, unknown>).filterName === signature[0],
      ),
    }));
    if (!found.some((x) => x.rows.length)) continue;
    let reason: MemberFilterField["unavailableReason"];
    let options: MemberFilterChoice[] = [];
    const operators: MemberFilterOperator[] = [];
    const bindings = new Map<string, Binding>();
    try {
      for (const { signature, rows: matches } of found) {
        const [, , operatorName] = signature;
        if (!matches.length) continue;
        if (matches.length !== 1) return invalidResponse("search_filter_shape");
        const f = definition(matches[0], signature);
        if (!permitted(f, everyone)) {
          reason = "permission_unverified";
          continue;
        }
        if (config.unverified) {
          reason = "unverified_semantics";
          continue;
        }
        const input = inputsOf(f);
        for (const key of ["searchTerm", "groupID", "date"])
          if (key in input && record(input[key]).allowedValues !== null)
            return invalidResponse("search_filter_shape");
        if (config.id === "membership")
          options = choices(record(input.otherGroupID).allowedValues, true);
        const contactDate =
          config.id === "email_updated" || config.id === "phone_updated";
        const names =
          config.type === "date" ? [...DATE_OPERATORS.keys()] : [operatorName];
        if (config.type === "date") {
          const values = record(input.dateQueryType).allowedValues;
          if (
            !Array.isArray(values) ||
            JSON.stringify(values.map((v) => record(v).value)) !==
              JSON.stringify([...DATE_OPERATORS.values()])
          )
            return invalidResponse("search_filter_shape");
        }
        for (const operator of names) {
          bindings.set(operator, {
            filterID: nativeId(f.filterID),
            fixedInputs: {},
          });
          operators.push({
            operator,
            // Contact-date negation has not been characterized.
            negation: !contactDate && f.operatorNegated !== undefined,
            missingValueBehavior:
              contactDate || (config.id === "phone" && operator === "verified")
                ? "excluded"
                : "native_unknown",
          });
        }
      }
    } catch (error) {
      if (!(error instanceof FlockbotError)) throw error;
      reason =
        error.reason === "search_filter_label"
          ? "unsafe_label"
          : "unsupported_definition";
    }
    // A damaged or denied definition must not leave a misleading partial field.
    fields.push({
      descriptor: {
        fieldId: config.id,
        displayName: config.name,
        type: config.type,
        available: !reason && operators.length > 0,
        ...(reason ? { unavailableReason: reason } : {}),
        operators: reason ? [] : operators,
      },
      choices: reason ? [] : options,
      bindings,
    });
  }
  return fields;
}

function customFields(
  sections: Record<string, unknown>,
  everyone: boolean,
): Field[] {
  const fields: Field[] = [];
  const personal = sections["Personal Info"];
  if (personal !== undefined)
    for (const category of Object.values(record(record(personal).categories))) {
      const c = record(category);
      if (!Array.isArray(c.filters)) continue;
      const rows = c.filters.filter(
        (v) =>
          v &&
          typeof v === "object" &&
          ["Select List Field Exists", "Select List Field Equals"].includes(
            String((v as Record<string, unknown>).filterName),
          ),
      );
      if (!rows.length) continue;
      // Even malformed requested definitions need a stable identity to report failure.
      let id: string, instanceId: string;
      try {
        const input = inputsOf(record(rows[0]));
        id = nativeId(record(input.networkFieldID).allowedValues);
        instanceId = nativeId(record(input.fieldTypeInstanceID).allowedValues);
      } catch (error) {
        if (!(error instanceof FlockbotError)) throw error;
        continue; // No safe identity to expose; a requested key will be unavailable.
      }
      const fieldId = `custom:${id}:select:${instanceId}`;
      const collision = fields.find((f) =>
        f.descriptor.fieldId.startsWith(`custom:${id}:`),
      );
      if (collision) {
        // Keep one unavailable descriptor, never choose between conflicting bindings.
        collision.descriptor = {
          ...collision.descriptor,
          available: false,
          unavailableReason: "unsupported_definition",
          operators: [],
        };
        collision.choices = [];
        continue;
      }
      let reason: MemberFilterField["unavailableReason"];
      let label = "Unavailable custom field";
      let options: MemberFilterChoice[] = [];
      const operators: MemberFilterOperator[] = [];
      const bindings = new Map<string, Binding>();
      try {
        label = text(c.displayName);
        const seen = new Set<string>();
        let instance: string | undefined;
        for (const row of rows) {
          const equals = record(row).filterName === "Select List Field Equals";
          const operator = equals ? "equals" : "exists";
          if (seen.has(operator)) return invalidResponse("search_filter_shape");
          seen.add(operator);
          const signature: Definition = [
            equals ? "Select List Field Equals" : "Select List Field Exists",
            equals ? "Is" : "Has",
            operator,
            {
              networkFieldID: "keyword",
              extendedFieldFieldType: "keyword",
              fieldTypeInstanceID: "keyword",
              ...(equals ? { listOfIDs: "keyword" } : {}),
            },
          ];
          const f = definition(row, signature),
            input = inputsOf(f);
          const current = nativeId(
            record(input.fieldTypeInstanceID).allowedValues,
          );
          if (
            nativeId(record(input.networkFieldID).allowedValues) !== id ||
            record(input.extendedFieldFieldType).allowedValues !== 5 ||
            f.extendedFieldFieldType !== 5 ||
            (instance !== undefined && instance !== current)
          )
            return invalidResponse("search_filter_shape");
          instance = current;
          if (!permitted(f, everyone)) {
            reason = "permission_unverified";
            continue;
          }
          if (equals) options = choices(record(input.listOfIDs).allowedValues);
          bindings.set(operator, {
            filterID: nativeId(f.filterID),
            fixedInputs: {
              networkFieldID: id,
              extendedFieldFieldType: "5",
              fieldTypeInstanceID: current,
            },
          });
          operators.push({
            operator,
            negation: f.operatorNegated !== undefined,
            missingValueBehavior: "native_unknown",
          });
        }
      } catch (error) {
        if (!(error instanceof FlockbotError)) throw error;
        reason =
          error.reason === "search_filter_label"
            ? "unsafe_label"
            : "unsupported_definition";
      }
      fields.push({
        descriptor: {
          fieldId,
          displayName: label,
          type: "select",
          available: !reason,
          ...(reason ? { unavailableReason: reason } : {}),
          operators: reason ? [] : operators,
        },
        choices: reason ? [] : options,
        bindings,
      });
    }
  return fields;
}

function catalog(data: Record<string, unknown>): Field[] {
  const sections = record(record(data.peopleFilterInfo).filters);
  const everyone = memberFlag(data.isEveryoneGroup);
  return [
    ...builtinFields(sections, everyone),
    ...customFields(sections, everyone),
  ].sort((a, b) =>
    a.descriptor.fieldId.localeCompare(b.descriptor.fieldId, "en"),
  );
}

async function readCatalog(
  input: MemberFiltersInput,
  context: ResourceQuery,
  network: Network,
) {
  context.check();
  const groupId =
    input.groupId ??
    (input.groupName === undefined
      ? (await network.discoverGroups(context)).find((g) => g.isEveryone)?.id
      : (await network.findGroup(context, input.groupName)).id);
  if (!groupId) throw new FlockbotError("everyone_not_found");
  context.check();
  const data = record(
    await context.query(
      `group/${groupId}/people?ajax`,
      "includeUnsubscribed=0",
    ),
  );
  context.check();
  if (data.canView === false) throw new FlockbotError("permission_denied");
  if (data.success === false)
    throw new FlockbotError(
      "upstream_rejected",
      undefined,
      undefined,
      undefined,
      "success_false",
    );
  if (data.success !== undefined && data.success !== true)
    return invalidResponse("expected_success");
  if (identifier(data.groupID) !== groupId)
    return invalidResponse("group_identity_mismatch");
  if (data.includeContacts !== false)
    return invalidResponse("contacts_included");
  const includeInactive = memberFlag(data.canViewInactiveMembers);
  return {
    groupId,
    includeInactive,
    everyone: memberFlag(data.isEveryoneGroup),
    fields: catalog(data),
    generalSearchFilter: record(data.peopleFilterInfo).generalSearchFilter,
  };
}

function availableField(fields: Field[], fieldId: string): Field {
  const selected = fields.find((f) => f.descriptor.fieldId === fieldId);
  if (!selected) throw new FlockbotError("member_filter_unavailable");
  if (!selected.descriptor.available) {
    if (selected.descriptor.unavailableReason === "unsupported_definition")
      return invalidResponse("search_filter_shape");
    if (selected.descriptor.unavailableReason === "unsafe_label")
      return invalidResponse("search_filter_label");
    throw new FlockbotError("member_filter_unavailable");
  }
  return selected;
}

/** Compile only validated catalog bindings; no upstream member records escape. */
export async function compileMemberSearch(
  input: {
    groupId?: string | undefined;
    groupName?: string | undefined;
    searchTerm?: string | undefined;
    criteria?: MemberCriteria | undefined;
    includeInactive: boolean;
  },
  context: ResourceQuery,
  network: Network,
) {
  const current = await readCatalog(input, context, network);
  if (input.includeInactive && !current.includeInactive)
    throw new FlockbotError("permission_denied");
  const body = new URLSearchParams({
    includeInactive: String(input.includeInactive),
  });
  const definitions: unknown[] = [];
  const put = (
    prefix: string,
    binding: Binding,
    negated: boolean,
    values: Record<string, string>,
  ) => {
    body.set(`${prefix}[filterID]`, binding.filterID);
    body.set(`${prefix}[isNegated]`, String(negated));
    for (const [key, value] of Object.entries({
      ...binding.fixedInputs,
      ...values,
    }))
      body.set(`${prefix}[inputs][${key}]`, value);
  };
  const any = (input.criteria?.any ?? []).map((branch, branchIndex) => ({
    all: branch.all.map((p, index) => {
      const field = availableField(current.fields, p.fieldId);
      const operator = field.descriptor.operators.find(
        (o) => o.operator === p.operator,
      );
      const binding = field.bindings.get(p.operator);
      if (!operator || !binding || (p.negated && !operator.negation))
        throw new FlockbotError("member_filter_unavailable");
      definitions.push({
        descriptor: field.descriptor,
        choices: field.choices,
        binding,
      });
      const values: Record<string, string> = {};
      let choice: MemberFilterChoice | undefined;
      const rule = OPERATOR_VALUES[p.operator];
      const value = rule === null ? undefined : memberSearchText(p.value);
      if (p.operator === "contains" && value !== undefined)
        values.searchTerm = value;
      if (p.operator === "equals" || p.operator === "in_group") {
        choice = field.choices.find((c) => c.id === value);
        if (!choice) throw new FlockbotError("member_filter_unavailable");
        values[p.operator === "equals" ? "listOfIDs" : "otherGroupID"] =
          choice.id;
      }
      if (field.descriptor.type === "date") {
        const dateQueryType = DATE_OPERATORS.get(p.operator);
        if (value === undefined || dateQueryType === undefined)
          throw new FlockbotError("member_filter_unavailable");
        if (p.fieldId === "subscribed") values.groupID = current.groupId;
        values.date = value;
        values.dateQueryType = dateQueryType;
      }
      put(
        `request[and][0][or][${branchIndex}][and][${index}]`,
        binding,
        p.negated === true,
        values,
      );
      return {
        ...p,
        displayName: field.descriptor.displayName,
        ...(choice ? { choiceLabel: choice.label } : {}),
        missingValueBehavior: operator.missingValueBehavior,
      };
    }),
  }));
  if (input.searchTerm !== undefined) {
    const f = record(current.generalSearchFilter);
    const search = record(record(f.inputs).searchTerm);
    if (
      f.filterName !== "generalPeopleSearch" ||
      f.operator !== "Search" ||
      Object.keys(record(f.inputs)).length !== 1 ||
      search.inputName !== "searchTerm" ||
      search.dataType !== "text" ||
      search.allowedValues !== null ||
      search.allowMultiple !== false
    )
      return invalidResponse("search_filter_shape");
    if (!permitted(f, current.everyone))
      throw new FlockbotError("member_filter_unavailable");
    definitions.push({
      fieldId: "general_search",
      filterID: nativeId(f.filterID),
      input: "text",
    });
    put(
      `request[and][${any.length ? 1 : 0}][or][0][and][0]`,
      { filterID: nativeId(f.filterID), fixedInputs: {} },
      false,
      { searchTerm: input.searchTerm },
    );
  }
  context.check();
  const criteriaSummary: MemberCriteriaSummary = {
    groupId: current.groupId,
    includeInactive: input.includeInactive,
    ...(input.searchTerm === undefined ? {} : { searchTerm: input.searchTerm }),
    any,
  };
  return {
    groupId: current.groupId,
    body: body.toString(),
    criteriaSummary,
    definitions,
  };
}

/** Read-only, scoped catalog projection. Native people rows never enter results. */
export class MemberFilters {
  readonly #input: MemberFiltersInput;
  constructor(input: MemberFiltersInput = {}) {
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).some(
        (k) => !["groupId", "groupName", "fieldId", "offset"].includes(k),
      ) ||
      (input.groupId !== undefined && input.groupName !== undefined)
    )
      throw new FlockbotError("invalid_input");
    const offset = input.offset === undefined ? 0 : input.offset;
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > Number.MAX_SAFE_INTEGER - MEMBER_FILTER_PAGE_SIZE ||
      (input.fieldId !== undefined &&
        (typeof input.fieldId !== "string" || !FIELD_ID.test(input.fieldId)))
    )
      throw new FlockbotError("invalid_input");
    this.#input = Object.freeze({
      ...(input.groupId === undefined
        ? {}
        : { groupId: inputIdentifier(input.groupId) }),
      ...(input.groupName === undefined
        ? {}
        : { groupName: normalizedGroupName(input.groupName) }),
      ...(input.fieldId === undefined ? {} : { fieldId: input.fieldId }),
      offset,
    });
  }
  async read(
    context: ResourceQuery,
    network: Network,
  ): Promise<MemberFiltersResult> {
    const input = this.#input;
    const { groupId, includeInactive, fields } = await readCatalog(
      input,
      context,
      network,
    );
    const selected =
      input.fieldId === undefined
        ? undefined
        : availableField(fields, input.fieldId);
    const offset = input.offset ?? 0;
    const total = selected ? selected.choices.length : fields.length;
    if (offset > total) throw new FlockbotError("invalid_input");
    const hasMore = offset + MEMBER_FILTER_PAGE_SIZE < total;
    return {
      groupId,
      includeInactive,
      ...(selected
        ? {
            field: selected.descriptor,
            choices: selected.choices.slice(
              offset,
              offset + MEMBER_FILTER_PAGE_SIZE,
            ),
          }
        : {
            fields: fields
              .slice(offset, offset + MEMBER_FILTER_PAGE_SIZE)
              .map((f) => f.descriptor),
          }),
      offset,
      total,
      hasMore,
      nextOffset: hasMore ? offset + MEMBER_FILTER_PAGE_SIZE : null,
    };
  }
  toInput(): MemberFiltersInput {
    return { ...this.#input };
  }
  toJSON(): object {
    return { type: "MemberFilters", redacted: true };
  }
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return "MemberFilters { [REDACTED] }";
  }
}
