import { FlockbotError } from "../errors.js";
import { identifier } from "./identifier.js";
import {
  type ContactValue,
  type GroupMemberField,
  groupMemberFields,
  memberFlag,
  memberName,
  storedContact,
  subscriptionDate,
} from "./member-fields.js";
import {
  type GroupSelector,
  membershipGroupSelector,
} from "./member-groups.js";
import type { Network } from "./network.js";
import { invalidResponse, record } from "./parsing.js";
import type { ResourceQuery } from "./resource-read.js";

export interface GroupMembersInput extends GroupSelector {
  readonly offset?: number | undefined;
  readonly fields?: readonly GroupMemberField[] | undefined;
}
export interface GroupMember {
  readonly id: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly email?: ContactValue;
  readonly mobilePhone?: ContactValue;
  /** Flocknote's reported subscription calendar date for this group. */
  readonly joinedOn?: string | null;
}
export interface GroupMembersResult {
  readonly groupId: string;
  readonly groupName?: string;
  readonly members: readonly GroupMember[];
  readonly offset: number;
  readonly returnedCount: number;
  readonly hasMore: boolean;
  readonly nextOffset: number | null;
  readonly includeUnsubscribed: false;
}

/** One bounded page of group subscribers within the adapter's coordinated read. */
export class GroupMembers {
  readonly #selector: Readonly<{ groupId: string } | { groupName: string }>;
  readonly #offset: number;
  readonly #fields: readonly GroupMemberField[];

  constructor(input: GroupMembersInput) {
    this.#selector = membershipGroupSelector(input);
    this.#offset = input.offset === undefined ? 0 : input.offset;
    if (
      !Number.isSafeInteger(this.#offset) ||
      this.#offset < 0 ||
      this.#offset > Number.MAX_SAFE_INTEGER - 100
    )
      throw new FlockbotError("invalid_input");
    this.#fields = groupMemberFields(input.fields);
    Object.freeze(this);
  }

  async list(
    context: ResourceQuery,
    network: Network,
  ): Promise<GroupMembersResult> {
    context.check();
    const group =
      "groupId" in this.#selector
        ? { id: this.#selector.groupId }
        : await network.findGroup(context, this.#selector.groupName);
    context.check();
    const path =
      this.#offset === 0
        ? `group/${group.id}/people?ajax`
        : `group/${group.id}/people/${this.#offset}?ajax&more`;
    const data = record(await context.query(path, "includeUnsubscribed=0"));
    context.check();
    if (data.success === false) throw new FlockbotError("upstream_rejected");
    if (data.canView === false) throw new FlockbotError("permission_denied");
    if (
      (data.success !== undefined && data.success !== true) ||
      (data.groupID !== undefined && identifier(data.groupID) !== group.id) ||
      data.includeContacts === true ||
      !Array.isArray(data.subscribedMembers) ||
      data.subscribedMembers.length > 100 ||
      typeof data.moreSubscribersExist !== "boolean" ||
      (data.moreSubscribersExist && data.subscribedMembers.length === 0)
    )
      return invalidResponse();

    const ids = new Set<string>();
    const members = data.subscribedMembers.map((value): GroupMember => {
      const row = record(value);
      const id = identifier(row.userID);
      const firstName = memberName(row.fn);
      const lastName = memberName(row.ln);
      if (
        id.length > 128 ||
        ids.has(id) ||
        (!firstName && !lastName) ||
        row.contactData
      )
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
        ...(this.#fields.includes("joinedOn")
          ? { joinedOn: subscriptionDate(row.date) }
          : {}),
      };
    });
    return {
      groupId: group.id,
      ...("name" in group ? { groupName: group.name } : {}),
      members,
      offset: this.#offset,
      returnedCount: members.length,
      hasMore: data.moreSubscribersExist,
      nextOffset: data.moreSubscribersExist
        ? this.#offset + members.length
        : null,
      includeUnsubscribed: false,
    };
  }

  /** Explicit IPC projection; no search/contact intent leaks through inspection. */
  toInput(): GroupMembersInput {
    return {
      ...this.#selector,
      offset: this.#offset,
      fields: [...this.#fields],
    };
  }
  toJSON(): object {
    return { type: "GroupMembers", redacted: true };
  }
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return "GroupMembers { [REDACTED] }";
  }
}
