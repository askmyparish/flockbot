import { FlockbotError } from "../errors.js";
import { identifier } from "./identifier.js";
import { invalidResponse } from "./parsing.js";

export type MemberField = "email" | "mobilePhone";
export type GroupMemberField = MemberField | "joinedOn";
export interface ContactValue {
  readonly value: string | null;
  readonly verified: boolean;
}

export function inputIdentifier(value: unknown): string {
  try {
    if (typeof value !== "string" || value.length > 128) throw new Error();
    return identifier(value);
  } catch {
    throw new FlockbotError("invalid_input");
  }
}

export function memberFields(value: unknown): readonly MemberField[] {
  if (value === undefined) return Object.freeze([]);
  if (
    !Array.isArray(value) ||
    value.length > 2 ||
    value.some((field) => field !== "email" && field !== "mobilePhone") ||
    new Set(value).size !== value.length
  )
    throw new FlockbotError("invalid_input");
  return Object.freeze([...value]) as readonly MemberField[];
}

export function groupMemberFields(value: unknown): readonly GroupMemberField[] {
  if (value === undefined) return Object.freeze([]);
  if (
    !Array.isArray(value) ||
    value.length > 3 ||
    value.some(
      (field) =>
        field !== "email" && field !== "mobilePhone" && field !== "joinedOn",
    ) ||
    new Set(value).size !== value.length
  )
    throw new FlockbotError("invalid_input");
  return Object.freeze([...value]) as readonly GroupMemberField[];
}

/** Parse the observed English display date without inventing a time or timezone. */
export function subscriptionDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match =
    /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ([1-9]|[12]\d|3[01]), (\d{4})$/.exec(
      value.trim(),
    );
  if (!match) return null;
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const month = months.indexOf(match[1] ?? "") + 1;
  const day = Number(match[2]);
  const year = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year === 0 || day > (days[month - 1] ?? 0)) return null;
  return `${match[3]}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Only observed boolean and 0/1 encodings, never truthiness or arbitrary strings. */
export function memberFlag(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (value === 0 || value === 1) return value === 1;
  return invalidResponse();
}

export function memberName(value: unknown): string {
  if (typeof value !== "string" || /\p{Cc}/u.test(value))
    return invalidResponse();
  return value.trim();
}

export function storedContact(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || /\p{Cc}/u.test(value))
    return invalidResponse();
  return value.trim() || null;
}
