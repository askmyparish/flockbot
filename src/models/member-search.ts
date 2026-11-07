import { FlockbotError } from "../errors.js";
import { identifier } from "./identifier.js";
import {
  type ContactValue,
  type MemberField,
  inputIdentifier,
  memberFields,
  memberFlag,
  memberName,
  storedContact,
} from "./member-fields.js";
import { type Network, normalizedGroupName } from "./network.js";
import { invalidResponse, record } from "./parsing.js";
import type { ResourceQuery } from "./resource-read.js";

export interface MemberSearchInput {
  readonly searchTerm: string;
  readonly groupId?: string | undefined;
  readonly groupName?: string | undefined;
  readonly fields?: readonly MemberField[] | undefined;
  readonly limit?: number | undefined;
}
export interface MemberCandidate {
  readonly id: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly email?: ContactValue;
  readonly mobilePhone?: ContactValue;
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
    return invalidResponse();
  const id = identifier(filter.filterID);
  if (!/^[1-9]\d*$/.test(id)) return invalidResponse();
  return id;
}

/** Validated private search intent; execution is supplied by the owning adapter. */
export class MemberSearch {
  readonly #term: string;
  readonly #groupId: string | undefined;
  readonly #groupName: string | undefined;
  readonly #fields: readonly MemberField[];
  readonly #limit: number;

  constructor(input: MemberSearchInput) {
    if (
      typeof input !== "object" ||
      input === null ||
      Array.isArray(input) ||
      typeof input.searchTerm !== "string" ||
      !input.searchTerm.trim() ||
      input.searchTerm.length > 256 ||
      /\p{Cc}/u.test(input.searchTerm) ||
      (input.groupId !== undefined && input.groupName !== undefined)
    )
      throw new FlockbotError("invalid_input");
    this.#term = input.searchTerm.trim();
    this.#groupId =
      input.groupId === undefined ? undefined : inputIdentifier(input.groupId);
    this.#groupName =
      input.groupName === undefined
        ? undefined
        : normalizedGroupName(input.groupName);
    this.#fields = memberFields(input.fields);
    this.#limit = input.limit === undefined ? 50 : input.limit;
    if (!Number.isInteger(this.#limit) || this.#limit < 1 || this.#limit > 50)
      throw new FlockbotError("invalid_input");
    Object.freeze(this);
  }

  async find(
    context: ResourceQuery,
    network: Network,
  ): Promise<MemberSearchResult> {
    context.check();
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
    if (data.success !== true) throw new FlockbotError("upstream_rejected");
    if (
      !Array.isArray(data.results) ||
      typeof data.resultCount !== "number" ||
      !Number.isSafeInteger(data.resultCount) ||
      data.resultCount < data.results.length
    )
      return invalidResponse();
    const ids = new Set<string>();
    const all = data.results.map((value): MemberCandidate => {
      const row = record(value);
      const id = identifier(row.userID);
      const firstName = memberName(row.fn);
      const lastName = memberName(row.ln);
      if (id.length > 128 || ids.has(id) || (!firstName && !lastName))
        return invalidResponse();
      ids.add(id);
      return {
        id,
        firstName,
        lastName,
        ...(this.#fields.includes("email")
          ? {
              email: {
                value: storedContact(row.mail),
                verified: memberFlag(row.mailVer),
              },
            }
          : {}),
        ...(this.#fields.includes("mobilePhone")
          ? {
              mobilePhone: {
                value: storedContact(row.phn),
                verified: memberFlag(row.phnVer),
              },
            }
          : {}),
      };
    });
    const members = all.slice(0, this.#limit);
    const complete = data.resultCount === members.length;
    const exact = complete
      ? members.filter(
          (member) =>
            normalizedName(`${member.firstName} ${member.lastName}`) ===
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
      searchTerm: this.#term,
      ...(this.#groupId === undefined ? {} : { groupId: this.#groupId }),
      ...(this.#groupName === undefined ? {} : { groupName: this.#groupName }),
      fields: [...this.#fields],
      limit: this.#limit,
    };
  }

  toJSON(): object {
    return { type: "MemberSearch", redacted: true };
  }
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return "MemberSearch { [REDACTED] }";
  }
}
