import { FlockbotError } from "../errors.js";
import type { FailureReason } from "../failure-reason.js";

/** Common structure checks for domain responses; authentication has its own contract. */
export function invalidResponse(reason?: FailureReason): never {
  throw new FlockbotError(
    "invalid_response",
    undefined,
    undefined,
    undefined,
    reason,
  );
}
export function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return invalidResponse("expected_object");
  return value as Record<string, unknown>;
}
export function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim())
    return invalidResponse("expected_text");
  return value.trim();
}

export function timestamp(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
    return invalidResponse("expected_timestamp");
  return value;
}

export function successful(value: unknown): Record<string, unknown> {
  const response = record(value);
  if (response.success === false)
    throw new FlockbotError(
      "upstream_rejected",
      undefined,
      undefined,
      undefined,
      "success_false",
    );
  if (response.success !== true) return invalidResponse("expected_success");
  return response;
}
