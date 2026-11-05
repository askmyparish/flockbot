import { FlockbotError } from "../errors.js";

/** Common structure checks for domain responses; authentication has its own contract. */
export function invalidResponse(): never {
  throw new FlockbotError("invalid_response");
}
export function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return invalidResponse();
  return value as Record<string, unknown>;
}
export function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return invalidResponse();
  return value.trim();
}
