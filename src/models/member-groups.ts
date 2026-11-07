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
interface MembershipRow extends MembershipGroup {
  readonly isSubscribed: boolean;
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

/** An identified membership-read intent; no preferences or contacts are retained. */
export class MemberGroups {
  readonly #userId: string;

  constructor(userId: string) {
    this.#userId = inputIdentifier(userId);
    Object.freeze(this);
  }

  async #rows(context: ResourceQuery): Promise<readonly MembershipRow[]> {
    context.check();
    const response = record(await context.query(`user/${this.#userId}/groups`));
    context.check();
    if (response.success !== true) throw new FlockbotError("upstream_rejected");
    const data = record(response.data);
    if (data.canView === false) throw new FlockbotError("permission_denied");
    if (data.canView !== true || !Array.isArray(data.subscribedGroups))
      return invalidResponse();
    const ids = new Set<string>();
    return data.subscribedGroups.map((value): MembershipRow => {
      const row = record(value);
      const id = identifier(row.groupID);
      const name = memberName(row.groupName);
      if (
        id.length > 128 ||
        !name ||
        ids.has(id) ||
        typeof row.isSubscribed !== "boolean"
      )
        return invalidResponse();
      ids.add(id);
      return { id, name, isSubscribed: row.isSubscribed };
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
    const selected = membershipGroupSelector(selector);
    context.check();
    const target =
      "groupId" in selected
        ? { id: selected.groupId }
        : await network.findGroup(context, selected.groupName);
    context.check();
    const row = (await this.#rows(context)).find(
      (group) => group.id === target.id,
    );
    const name = row?.name ?? ("name" in target ? target.name : undefined);
    return {
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
