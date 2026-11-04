import { identifier } from "./groups.js";
import { FlockbotError } from "./index.js";

export interface MemberInput {
  readonly firstName: string;
  readonly lastName: string;
  readonly email?: string | null | undefined;
  readonly mobilePhone?: string | null | undefined;
}

export interface AddMemberResult {
  readonly success: true;
}

function invalid(): never {
  throw new FlockbotError("invalid_input", undefined, "not_submitted");
}

function field(value: unknown, optional = false): string {
  if (optional && (value === undefined || value === null)) return "";
  if (typeof value !== "string") return invalid();
  const trimmed = value.trim();
  if (/\p{Cc}/u.test(trimmed) || (!optional && !trimmed)) return invalid();
  return trimmed;
}

/** Normalize a private request snapshot; never retain or return member details. */
export function membershipRequest(
  groupId: unknown,
  member: MemberInput,
): { path: string; body: string } {
  let id: string;
  try {
    id = identifier(groupId);
  } catch {
    return invalid();
  }
  if (typeof member !== "object" || member === null || Array.isArray(member))
    return invalid();
  const fname = field(member.firstName);
  const lname = field(member.lastName);
  const email = field(member.email, true);
  const mobile = field(member.mobilePhone, true);
  if (!email && !mobile) return invalid();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return invalid();
  if (
    mobile &&
    (!/^\+?[\d(). -]+$/.test(mobile) ||
      mobile.replace(/\D/g, "").length < 7 ||
      mobile.replace(/\D/g, "").length > 15)
  )
    return invalid();
  return {
    path: `group/${id}/addToGroupByAdmin`,
    body: new URLSearchParams({
      fname,
      lname,
      email,
      mobile_phone: mobile,
    }).toString(),
  };
}

export function confirmedMembership(value: unknown): AddMemberResult {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("success" in value) ||
    value.success !== true
  )
    throw new FlockbotError("invalid_response");
  return Object.freeze({ success: true });
}
