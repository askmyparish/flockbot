import { FlockbotError } from "../errors.js";
import { identifier } from "./identifier.js";
import { User, type UserInput } from "./user.js";
import { invalidResponse } from "./parsing.js";
export type MemberInput = UserInput;
export interface AddMemberResult {
  readonly success: true;
}
export interface MembershipRequest {
  readonly path: string;
  readonly body: string;
}
export type MembershipExecutor = (
  request: MembershipRequest,
  parse: (value: unknown) => AddMemberResult,
) => Promise<AddMemberResult>;

/**
 * A prepared membership addition linking validated user contact details to a group.
 * Owns form construction and success parsing. The supplied executor owns session
 * coordination, submission and write outcomes; this model never retries a write.
 * Construction prepares local data without creating an upstream membership.
 */
export class GroupMembership {
  readonly groupId: string;
  readonly #body: string;
  constructor(groupId: unknown, user: User) {
    try {
      this.groupId = identifier(groupId);
    } catch {
      throw new FlockbotError("invalid_input", undefined, "not_submitted");
    }
    this.#body = new URLSearchParams({
      fname: user.firstName,
      lname: user.lastName,
      email: user.email,
      mobile_phone: user.mobilePhone,
    }).toString();
    Object.freeze(this);
  }
  request(): MembershipRequest {
    return {
      path: `group/${this.groupId}/addToGroupByAdmin`,
      body: this.#body,
    };
  }
  add(execute: MembershipExecutor): Promise<AddMemberResult> {
    return execute(this.request(), confirmedMembership);
  }
  toJSON(): object {
    return { type: "GroupMembership", groupId: this.groupId };
  }
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return `GroupMembership { groupId: ${this.groupId} }`;
  }
}

/** Validate an addition without fetching a person or submitting any request. */
export function membershipRequest(
  groupId: unknown,
  input: UserInput,
): MembershipRequest {
  return new GroupMembership(groupId, new User(input)).request();
}
export function confirmedMembership(value: unknown): AddMemberResult {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("success" in value) ||
    value.success !== true
  )
    return invalidResponse("membership_confirmation");
  return Object.freeze({ success: true });
}
