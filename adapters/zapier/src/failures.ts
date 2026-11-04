import { randomUUID } from "node:crypto";
import { FlockbotError, type UpstreamResponse } from "../../../src/index.js";

const inputFields = [
  "group_id",
  "user_first_name",
  "user_last_name",
  "user_email",
  "user_mobile_phone",
] as const;
type InputValue = string | number | boolean | null;
export interface MembershipAttempt {
  readonly attempt_id: string;
  readonly timestamp: string;
  readonly app_version: string;
  readonly inputs: Readonly<Record<(typeof inputFields)[number], InputValue>>;
  readonly inputs_truncated: boolean;
}
export type FailureStage = "validation" | "group_lookup" | "membership";
export interface MembershipFailure extends MembershipAttempt {
  readonly event: "flockbot.membership_failed";
  readonly parish?: string;
  readonly stage: FailureStage;
  readonly code: string;
  readonly outcome: "unknown" | "not_submitted";
  readonly http_status?: number;
  readonly response?: UpstreamResponse;
}
export interface FailureConsole {
  readonly console?: { log: (message: string) => void };
}

/** Snapshot exactly the five action inputs; never copy a connection or bundle. */
export function membershipAttempt(
  input: unknown,
  version: string,
): MembershipAttempt {
  let truncated = false;
  const values =
    typeof input === "object" && input !== null && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  const entries = inputFields.map((field) => {
    const value = values[field];
    let safe: InputValue = null;
    if (typeof value === "string") {
      const text = value.trim();
      if (text.length > 1024) truncated = true;
      safe = text.slice(0, 1024);
    } else if (
      (typeof value === "number" && Number.isFinite(value)) ||
      typeof value === "boolean"
    )
      safe = value;
    else if (value !== undefined && value !== null)
      safe = "[invalid input type]";
    return [field, safe];
  });
  return Object.freeze({
    attempt_id: randomUUID(),
    timestamp: new Date().toISOString(),
    app_version: version,
    inputs: Object.freeze(
      Object.fromEntries(entries),
    ) as MembershipAttempt["inputs"],
    inputs_truncated: truncated,
  });
}

export function membershipFailure(
  error: unknown,
  attempt: MembershipAttempt,
  stage: FailureStage,
  parish?: string,
): MembershipFailure {
  return Object.freeze({
    ...attempt,
    event: "flockbot.membership_failed",
    ...(parish ? { parish } : {}),
    stage,
    code: error instanceof FlockbotError ? error.code : "adapter_failed",
    outcome:
      error instanceof FlockbotError && error.outcome
        ? error.outcome
        : stage === "membership"
          ? "unknown"
          : "not_submitted",
    ...(error instanceof FlockbotError && error.status !== undefined
      ? { http_status: error.status }
      : {}),
    ...(error instanceof FlockbotError && error.response
      ? { response: error.response }
      : {}),
  });
}

/** Logging failure must never change the write outcome or make it replayable. */
export function reportMembershipFailure(
  z: FailureConsole,
  report: MembershipFailure,
): void {
  try {
    z.console?.log(JSON.stringify(report));
  } catch {
    /* Preserve the original membership failure. */
  }
}

export function failureSummary(report: MembershipFailure): string {
  const contacts = [
    report.inputs.user_email
      ? `email ${JSON.stringify(report.inputs.user_email)}`
      : "",
    report.inputs.user_mobile_phone
      ? `mobile ${JSON.stringify(report.inputs.user_mobile_phone)}`
      : "",
  ]
    .filter(Boolean)
    .join(", ");
  const response = report.response?.error;
  const detail = response
    ? `Flocknote returned ${JSON.stringify(response)}${report.response?.errorTruncated ? " [truncated]" : ""}`
    : `Flockbot reported ${report.code}`;
  return `Could not add member${contacts ? ` (${contacts})` : ""} to group ${JSON.stringify(report.inputs.group_id)}. ${detail}${report.http_status ? ` (HTTP ${report.http_status})` : ""}. Membership completion is unconfirmed; automatic retry is disabled. Check Flocknote before repeating. Attempt ${report.attempt_id}.`;
}
