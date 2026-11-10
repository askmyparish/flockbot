import { invalidResponse as invalid, record } from "./parsing.js";
import { FlockbotError } from "../errors.js";
import type { OperationOptions } from "../operation.js";
import { identifier } from "./identifier.js";
import type { UserInput } from "./user.js";
import type { AddMemberResult } from "./group-membership.js";
import type { ResourceRead } from "./resource-read.js";
export interface GroupAttributes {
  readonly id: string;
  readonly name: string;
  readonly shortName: string;
  readonly isEveryone: boolean;
}
export interface SubscriberCountOptions extends OperationOptions {
  readonly force?: boolean;
}

/**
 * Group metadata and group-scoped operations, obtained from client.groups().
 * Supplied callbacks execute within the owning client's session and coordination
 * boundary. The instance's subscriber count cache lasts until a forced refresh;
 * constructing a Group performs no request.
 */
export class Group implements GroupAttributes {
  readonly id: string;
  readonly name: string;
  readonly shortName: string;
  readonly isEveryone: boolean;
  readonly #readCount: (options: OperationOptions) => Promise<number>;
  readonly #addMember: (
    user: UserInput,
    options: OperationOptions,
  ) => Promise<AddMemberResult>;
  #count: number | undefined;

  constructor(
    attributes: GroupAttributes,
    readCount: (options: OperationOptions) => Promise<number>,
    addMember: (
      user: UserInput,
      options: OperationOptions,
    ) => Promise<AddMemberResult>,
  ) {
    this.id = attributes.id;
    this.name = attributes.name;
    this.shortName = attributes.shortName;
    this.isEveryone = attributes.isEveryone;
    this.#readCount = readCount;
    this.#addMember = addMember;
    Object.freeze(this);
  }

  async subscriberCount(options: SubscriberCountOptions = {}): Promise<number> {
    if (options.signal?.aborted) throw new FlockbotError("operation_cancelled");
    if (this.#count !== undefined && !options.force) return this.#count;
    const count = await this.#readCount(options);
    this.#count = count;
    return count;
  }
  addMember(
    user: UserInput,
    options: OperationOptions = {},
  ): Promise<AddMemberResult> {
    return this.#addMember(user, options);
  }

  static async readSubscriberCount(
    context: ResourceRead,
    groupId: string | number,
  ): Promise<number> {
    const value = await context.read(
      `group/${identifier(groupId)}/getSubscriberCount`,
    );
    const count = subscriberCount(value);
    context.check();
    return count;
  }
}

export function subscriberCount(value: unknown): number {
  const count = record(value).subscriberCount;
  if (typeof count === "number") {
    if (Number.isSafeInteger(count) && count >= 0) return count;
    return invalid("subscriber_count_invalid");
  }
  if (
    typeof count !== "string" ||
    !/^(?:\d+|[1-9]\d{0,2}(?:,\d{3})+)$/.test(count.trim())
  )
    return invalid("subscriber_count_invalid");
  const parsed = Number(count.trim().replaceAll(",", ""));
  if (!Number.isSafeInteger(parsed)) return invalid("subscriber_count_invalid");
  return parsed;
}
