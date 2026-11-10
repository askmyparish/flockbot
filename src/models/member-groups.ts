import { FlockbotError } from "../errors.js";
import { identifier } from "./identifier.js";
import { inputIdentifier, memberName } from "./member-fields.js";
import { type Network, normalizedGroupName } from "./network.js";
import { invalidResponse, record } from "./parsing.js";
import type { ResourceQuery } from "./resource-read.js";

export interface MembershipGroup {
  readonly id: string;
  readonly name: string;
}
export interface MemberGroupsResult {
  readonly userId: string;
  readonly groups: readonly MembershipGroup[];
  readonly observedCount: number;
  readonly returnedCount: number;
  readonly truncated: boolean;
  /** The observed response does not establish an exhaustive membership view. */
  readonly complete: false;
}
export interface GroupSelector {
  readonly groupId?: string | undefined;
  readonly groupName?: string | undefined;
}
export interface MembershipCheckResult {
  readonly userId: string;
  readonly groupId: string;
  readonly groupName?: string;
  readonly membership: "member" | "not_member" | "unknown";
}
export type CommunicationPreference = "enabled" | "disabled" | "unknown";
interface MembershipRow extends MembershipGroup {
  readonly isSubscribed: boolean;
  readonly emailPreference?: CommunicationPreference;
  readonly smsPreference?: CommunicationPreference;
}

function preference(
  row: Record<string, unknown>,
  key: string,
): CommunicationPreference {
  if (!Object.hasOwn(row, key)) return "unknown";
  if (row[key] === 1) return "enabled";
  if (row[key] === 0) return "disabled";
  return invalidResponse("invalid_preference");
}

/** Validate and snapshot a selected group before an adapter starts I/O. */
export function membershipGroupSelector(
  value: GroupSelector,
): Readonly<{ groupId: string } | { groupName: string }> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (value.groupId === undefined) === (value.groupName === undefined)
  )
    throw new FlockbotError("invalid_input");
  return Object.freeze(
    value.groupId === undefined
      ? { groupName: normalizedGroupName(value.groupName as string) }
      : { groupId: inputIdentifier(value.groupId) },
  );
}

/** An identified membership-read intent; no contacts are retained. */
export class MemberGroups {
  readonly #userId: string;

  constructor(userId: string) {
    this.#userId = inputIdentifier(userId);
    Object.freeze(this);
  }

  async #rows(
    context: ResourceQuery,
    preferences = false,
  ): Promise<readonly MembershipRow[]> {
    context.check();
    const response = record(await context.query(`user/${this.#userId}/groups`));
    context.check();
    if (response.success !== true)
      throw new FlockbotError(
        "upstream_rejected",
        undefined,
        undefined,
        undefined,
        response.success === false ? "success_false" : "expected_success",
      );
    const data = record(response.data);
    if (data.canView === false) throw new FlockbotError("permission_denied");
    if (data.canView !== true) return invalidResponse("expected_boolean");
    if (!Array.isArray(data.subscribedGroups))
      return invalidResponse("expected_group_array");
    const ids = new Set<string>();
    return data.subscribedGroups.map((value): MembershipRow => {
      const row = record(value);
      const id = identifier(row.groupID);
      const name = memberName(row.groupName);
      if (id.length > 128) return invalidResponse("identifier_too_long");
      if (!name) return invalidResponse("missing_name");
      if (ids.has(id)) return invalidResponse("duplicate_identifier");
      if (typeof row.isSubscribed !== "boolean")
        return invalidResponse("expected_subscription_boolean");
      ids.add(id);
      return {
        id,
        name,
        isSubscribed: row.isSubscribed,
        ...(preferences
          ? {
              emailPreference: preference(row, "emailPref"),
              smsPreference: preference(row, "smsPref"),
            }
          : {}),
      };
    });
  }

  async list(context: ResourceQuery): Promise<MemberGroupsResult> {
    const positive = (await this.#rows(context)).filter(
      (row) => row.isSubscribed,
    );
    const groups = positive.slice(0, 50).map(({ id, name }) => ({ id, name }));
    return {
      userId: this.#userId,
      groups,
      observedCount: positive.length,
      returnedCount: groups.length,
      truncated: groups.length < positive.length,
      complete: false,
    };
  }

  async check(
    context: ResourceQuery,
    network: Network,
    selector: GroupSelector,
  ): Promise<MembershipCheckResult> {
    return (await this.#select(context, network, selector, false)).membership;
  }

  async communication(
    context: ResourceQuery,
    network: Network,
    selector: GroupSelector,
  ) {
    const { membership, row } = await this.#select(
      context,
      network,
      selector,
      true,
    );
    return {
      ...membership,
      emailPreference: row?.emailPreference ?? "unknown",
      smsPreference: row?.smsPreference ?? "unknown",
    };
  }

  async #select(
    context: ResourceQuery,
    network: Network,
    selector: GroupSelector,
    preferences: boolean,
  ) {
    const selected = membershipGroupSelector(selector);
    context.check();
    const target =
      "groupId" in selected
        ? { id: selected.groupId }
        : await network.findGroup(context, selected.groupName);
    context.check();
    const row = (await this.#rows(context, preferences)).find(
      (group) => group.id === target.id,
    );
    const name = row?.name ?? ("name" in target ? target.name : undefined);
    const membership: MembershipCheckResult = {
      userId: this.#userId,
      groupId: target.id,
      ...(name === undefined ? {} : { groupName: name }),
      membership:
        row === undefined
          ? "unknown"
          : row.isSubscribed
            ? "member"
            : "not_member",
    };
    return { membership, row };
  }

  /** Explicit IPC projection; default inspection and JSON stay redacted. */
  toInput(): { userId: string } {
    return { userId: this.#userId };
  }
  toJSON(): object {
    return { type: "MemberGroups", redacted: true };
  }
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return "MemberGroups { [REDACTED] }";
  }
}
