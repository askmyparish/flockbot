import { FlockbotError } from "../errors.js";
import { MAX_REQUEST_BYTES } from "../request-limits.js";
import {
  compileMemberSearch,
  memberCriteria,
  memberSearchText,
  type MemberCriteria,
  type MemberCriteriaSummary,
} from "./member-filters.js";
import { identifier } from "./identifier.js";
import {
  type ContactValue,
  type GroupMemberField,
  groupMemberFields,
  inputIdentifier,
  memberFlag,
  memberName,
  storedContact,
  subscriptionDate,
} from "./member-fields.js";
import { type Network, normalizedGroupName } from "./network.js";
import { invalidResponse, record } from "./parsing.js";
import type { ResourceQuery } from "./resource-read.js";

export type MemberSearchField = GroupMemberField;

export interface MemberSearchContinuation {
  readonly offset: number;
  readonly resultCount: number;
  readonly queryKey: string;
  readonly previousPageKey: string;
}
/** An opaque host-owned connection generation, independent of session renewal. */
export interface MemberSearchBinding {
  readonly connectionGeneration: string;
}
export interface MemberSearchInput {
  readonly searchTerm?: string | undefined;
  readonly mode?: "count" | "members" | undefined;
  readonly continuation?: MemberSearchContinuation | undefined;
  readonly criteria?: MemberCriteria | undefined;
  readonly includeInactive?: boolean | undefined;
  readonly groupId?: string | undefined;
  readonly groupName?: string | undefined;
  readonly fields?: readonly MemberSearchField[] | undefined;
  readonly limit?: number | undefined;
}
export interface MemberCountResult {
  readonly mode: "count";
  readonly groupId: string;
  readonly includeInactive: boolean;
  readonly resultCount: number;
  readonly criteriaSummary: MemberCriteriaSummary;
}
export interface MemberPageResult extends Omit<MemberCountResult, "mode"> {
  readonly mode: "members";
  readonly members: readonly MemberCandidate[];
  readonly returnedCount: number;
  readonly offset: number;
  readonly hasMore: boolean;
  readonly nextContinuation: MemberSearchContinuation | null;
  readonly complete: boolean;
}
export type MemberSearchResultFor<T extends MemberSearchInput> = T extends {
  mode: "count";
}
  ? MemberCountResult
  : T extends { mode: "members" }
    ? MemberPageResult
    : "mode" extends keyof T
      ? MemberCountResult | MemberPageResult | MemberSearchResult
      : MemberSearchResult;
export interface MemberCandidate {
  readonly id: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly email?: ContactValue;
  readonly mobilePhone?: ContactValue;
  /** Flocknote's reported subscription calendar date for the searched group. */
  readonly joinedOn?: string | null;
}
export interface MemberSearchResult {
  readonly groupId: string;
  readonly includeInactive: false;
  readonly members: readonly MemberCandidate[];
  readonly resultCount: number;
  readonly returnedCount: number;
  /** Complete only within this group's active-member query and returned count. */
  readonly complete: boolean;
  readonly exactMatchUserId?: string;
}

function normalizedName(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toLowerCase();
}

function continuation(
  value: MemberSearchContinuation,
): MemberSearchContinuation {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !==
      "offset,previousPageKey,queryKey,resultCount" ||
    !Number.isSafeInteger(value.offset) ||
    value.offset < 0 ||
    !Number.isSafeInteger(value.resultCount) ||
    value.resultCount < value.offset ||
    typeof value.queryKey !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.queryKey) ||
    typeof value.previousPageKey !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.previousPageKey)
  )
    throw new FlockbotError("invalid_input");
  return Object.freeze({ ...value });
}

// Only validated, JSON-shaped query definitions and ordered IDs enter hashes.
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, child]) => [key, canonical(child)]),
    );
  return value;
}
async function fingerprint(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(canonical(value)));
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

function memberRows(
  rows: unknown[],
  fields: readonly MemberSearchField[],
): MemberCandidate[] {
  const ids = new Set<string>();
  return rows.map((value): MemberCandidate => {
    const row = record(value);
    const id = identifier(row.userID);
    const firstName = memberName(row.fn);
    const lastName = memberName(row.ln);
    if (id.length > 128) return invalidResponse("identifier_too_long");
    if (ids.has(id)) return invalidResponse("duplicate_identifier");
    if (!firstName && !lastName) return invalidResponse("missing_name");
    ids.add(id);
    return {
      id,
      firstName,
      lastName,
      ...(fields.includes("email")
        ? {
            email: {
              value: storedContact(row.mail),
              verified: memberFlag(row.mailVer),
            },
          }
        : {}),
      ...(fields.includes("mobilePhone")
        ? {
            mobilePhone: {
              value: storedContact(row.phn),
              verified: memberFlag(row.phnVer),
            },
          }
        : {}),
      ...(fields.includes("joinedOn")
        ? { joinedOn: subscriptionDate(row.date) }
        : {}),
    };
  });
}

function searchFilter(value: unknown): string {
  const info = record(record(value).peopleFilterInfo);
  const filter = record(info.generalSearchFilter);
  const input = record(record(filter.inputs).searchTerm);
  if (
    filter.filterName !== "generalPeopleSearch" ||
    filter.operator !== "Search" ||
    input.inputName !== "searchTerm" ||
    input.dataType !== "text" ||
    input.allowMultiple !== false
  )
    return invalidResponse("search_filter_shape");
  const id = identifier(filter.filterID);
  if (!/^[1-9]\d*$/.test(id))
    return invalidResponse("search_filter_identifier");
  return id;
}

/** Validated private search intent; execution is supplied by the owning adapter. */
export class MemberSearch<T extends MemberSearchInput = MemberSearchInput> {
  readonly #term: string;
  readonly #groupId: string | undefined;
  readonly #groupName: string | undefined;
  readonly #fields: readonly MemberSearchField[];
  readonly #limit: number;
  readonly #mode: "count" | "members" | undefined;
  readonly #continuation: MemberSearchContinuation | undefined;
  readonly #criteria: MemberCriteria | undefined;
  readonly #includeInactive: boolean;

  constructor(input: T) {
    if (
      typeof input !== "object" ||
      input === null ||
      Array.isArray(input) ||
      Object.keys(input).some(
        (k) =>
          ![
            "mode",
            "searchTerm",
            "criteria",
            "includeInactive",
            "groupId",
            "groupName",
            "fields",
            "limit",
            "continuation",
          ].includes(k),
      ) ||
      (input.mode !== undefined &&
        input.mode !== "count" &&
        input.mode !== "members") ||
      (input.groupId !== undefined && input.groupName !== undefined)
    )
      throw new FlockbotError("invalid_input");
    this.#mode = input.mode;
    if (
      (this.#mode === "count" &&
        (input.fields !== undefined || input.limit !== undefined)) ||
      (this.#mode === undefined &&
        (input.criteria !== undefined ||
          input.includeInactive !== undefined)) ||
      (this.#mode !== "members" && input.continuation !== undefined)
    )
      throw new FlockbotError("invalid_input");
    if (
      input.includeInactive !== undefined &&
      typeof input.includeInactive !== "boolean"
    )
      throw new FlockbotError("invalid_input");
    this.#includeInactive = input.includeInactive === true;
    this.#criteria =
      input.criteria === undefined ? undefined : memberCriteria(input.criteria);
    this.#term =
      this.#mode !== undefined && input.searchTerm === undefined
        ? ""
        : memberSearchText(input.searchTerm);
    if (!this.#term && !this.#criteria)
      throw new FlockbotError("invalid_input");
    this.#groupId =
      input.groupId === undefined ? undefined : inputIdentifier(input.groupId);
    this.#groupName =
      input.groupName === undefined
        ? undefined
        : normalizedGroupName(input.groupName);
    this.#fields = groupMemberFields(input.fields);
    this.#limit =
      input.limit === undefined
        ? this.#mode === "members"
          ? 100
          : 50
        : input.limit;
    if (
      !Number.isInteger(this.#limit) ||
      this.#limit < 1 ||
      this.#limit > (this.#mode === "members" ? 100 : 50)
    )
      throw new FlockbotError("invalid_input");
    this.#continuation =
      input.continuation === undefined
        ? undefined
        : continuation(input.continuation);
    // Reject obviously oversized intent here. The adapter also checks the full
    // authenticated frame, whose overhead can reject a near-limit input.
    if (
      this.#mode !== undefined &&
      new TextEncoder().encode(JSON.stringify(this.toInput())).length >
        MAX_REQUEST_BYTES
    )
      throw new FlockbotError(
        "invalid_input",
        undefined,
        undefined,
        undefined,
        "request_too_large",
      );
    Object.freeze(this);
  }

  async find(
    context: ResourceQuery,
    network: Network,
    binding?: MemberSearchBinding,
  ): Promise<MemberSearchResultFor<T>>;
  async find(
    context: ResourceQuery,
    network: Network,
    binding?: MemberSearchBinding,
  ): Promise<MemberSearchResult | MemberCountResult | MemberPageResult> {
    context.check();
    if (this.#mode !== undefined) {
      if (
        this.#mode === "members" &&
        (typeof binding?.connectionGeneration !== "string" ||
          !binding.connectionGeneration ||
          binding.connectionGeneration.length > 256)
      )
        throw new FlockbotError("invalid_configuration");
      const compiled = await compileMemberSearch(
        {
          groupId: this.#groupId,
          groupName: this.#groupName,
          searchTerm: this.#term || undefined,
          criteria: this.#criteria,
          includeInactive: this.#includeInactive,
        },
        context,
        network,
      );
      const offset = this.#continuation?.offset ?? 0;
      const queryKey =
        this.#mode === "members"
          ? await fingerprint({
              version: 1,
              origin: network.origin,
              generation: binding?.connectionGeneration,
              groupId: compiled.groupId,
              body: compiled.body,
              fields: [...this.#fields].sort(),
              limit: this.#limit,
              definitions: compiled.definitions,
            })
          : undefined;
      if (this.#continuation && this.#continuation.queryKey !== queryKey)
        throw new FlockbotError("member_search_changed");
      context.check();
      const body = new URLSearchParams(compiled.body);
      if (this.#mode === "members") body.set("from", String(offset));
      const data = record(
        await context.query(
          `group/${compiled.groupId}/filter`,
          body.toString(),
        ),
      );
      context.check();
      if (data.canView === false) throw new FlockbotError("permission_denied");
      if (data.success !== true)
        throw new FlockbotError(
          "upstream_rejected",
          undefined,
          undefined,
          undefined,
          data.success === false ? "success_false" : "expected_success",
        );
      if (
        data.groupID !== undefined &&
        identifier(data.groupID) !== compiled.groupId
      )
        return invalidResponse("group_identity_mismatch");
      if (data.includeContacts !== undefined && data.includeContacts !== false)
        return invalidResponse("contacts_included");
      if (!Array.isArray(data.results))
        return invalidResponse("expected_results_array");
      if (data.results.length > 100)
        return invalidResponse("page_limit_exceeded");
      if (
        typeof data.resultCount !== "number" ||
        !Number.isSafeInteger(data.resultCount) ||
        data.resultCount < data.results.length ||
        data.resultCount < 0
      )
        return invalidResponse("invalid_result_count");
      if (this.#mode === "members") {
        if (
          this.#continuation &&
          data.resultCount !== this.#continuation.resultCount
        )
          throw new FlockbotError("member_search_changed");
        if (
          offset > data.resultCount ||
          data.results.length > data.resultCount - offset
        )
          return invalidResponse("invalid_result_count");
        if (!data.results.length && offset < data.resultCount)
          throw new FlockbotError("member_search_incomplete");
        const members = memberRows(data.results, this.#fields).slice(
          0,
          this.#limit,
        );
        const pageKey = await fingerprint(members.map((member) => member.id));
        context.check();
        if (this.#continuation?.previousPageKey === pageKey && members.length)
          throw new FlockbotError("member_search_incomplete");
        const nextOffset = offset + members.length;
        const hasMore = nextOffset < data.resultCount;
        return {
          mode: "members",
          groupId: compiled.groupId,
          includeInactive: this.#includeInactive,
          criteriaSummary: compiled.criteriaSummary,
          members,
          resultCount: data.resultCount,
          returnedCount: members.length,
          offset,
          hasMore,
          nextContinuation:
            hasMore && queryKey
              ? {
                  offset: nextOffset,
                  resultCount: data.resultCount,
                  queryKey,
                  previousPageKey: pageKey,
                }
              : null,
          complete: offset === 0 && !hasMore,
        };
      }
      return {
        mode: "count",
        groupId: compiled.groupId,
        includeInactive: this.#includeInactive,
        resultCount: data.resultCount,
        criteriaSummary: compiled.criteriaSummary,
      };
    }
    const groupId =
      this.#groupId ??
      (this.#groupName === undefined
        ? (await network.discoverGroups(context)).find(
            (group) => group.isEveryone,
          )?.id
        : (await network.findGroup(context, this.#groupName)).id);
    if (!groupId) throw new FlockbotError("everyone_not_found");
    context.check();
    const filter = searchFilter(
      await context.query(
        `group/${groupId}/people?ajax`,
        "includeUnsubscribed=0",
      ),
    );
    context.check();
    const prefix = "request[and][0][or][0][and][0]";
    const body = new URLSearchParams({
      [`${prefix}[filterID]`]: filter,
      [`${prefix}[isNegated]`]: "false",
      [`${prefix}[inputs][searchTerm]`]: this.#term,
      includeInactive: "false",
    }).toString();
    const data = record(await context.query(`group/${groupId}/filter`, body));
    context.check();
    if (data.success !== true)
      throw new FlockbotError(
        "upstream_rejected",
        undefined,
        undefined,
        undefined,
        data.success === false ? "success_false" : "expected_success",
      );
    if (!Array.isArray(data.results))
      return invalidResponse("expected_results_array");
    if (
      typeof data.resultCount !== "number" ||
      !Number.isSafeInteger(data.resultCount) ||
      data.resultCount < data.results.length
    )
      return invalidResponse("invalid_result_count");
    const all = memberRows(data.results, this.#fields);
    const members = all.slice(0, this.#limit);
    const complete = data.resultCount === members.length;
    const exact = complete
      ? members.filter((member) =>
          this.#term.includes("@")
            ? member.email?.value?.toLowerCase() === this.#term.toLowerCase()
            : normalizedName(`${member.firstName} ${member.lastName}`) ===
              normalizedName(this.#term),
        )
      : [];
    return {
      groupId,
      includeInactive: false,
      members,
      resultCount: data.resultCount,
      returnedCount: members.length,
      complete,
      ...(exact.length === 1 && exact[0]
        ? { exactMatchUserId: exact[0].id }
        : {}),
    };
  }

  /** Explicit transport projection; never included in default inspection/JSON. */
  toInput(): MemberSearchInput {
    return {
      ...(this.#term ? { searchTerm: this.#term } : {}),
      ...(this.#groupId === undefined ? {} : { groupId: this.#groupId }),
      ...(this.#groupName === undefined ? {} : { groupName: this.#groupName }),
      ...(this.#mode !== undefined
        ? {
            mode: this.#mode,
            includeInactive: this.#includeInactive,
            ...(this.#criteria ? { criteria: this.#criteria } : {}),
            ...(this.#mode === "members"
              ? {
                  fields: [...this.#fields],
                  limit: this.#limit,
                  ...(this.#continuation
                    ? { continuation: this.#continuation }
                    : {}),
                }
              : {}),
          }
        : { fields: [...this.#fields], limit: this.#limit }),
    };
  }

  toJSON(): object {
    return { type: "MemberSearch", redacted: true };
  }
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return "MemberSearch { [REDACTED] }";
  }
}
