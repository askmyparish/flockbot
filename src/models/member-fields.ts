import { FlockbotError } from "../errors.js";
import { identifier } from "./identifier.js";
import { invalidResponse } from "./parsing.js";

export type MemberField = "email" | "mobilePhone";
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
