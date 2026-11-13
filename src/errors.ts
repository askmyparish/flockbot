import { upstreamResponse, type UpstreamResponse } from "./rejections.js";
import { safeFailureReason, type FailureReason } from "./failure-reason.js";

export const DRAFT_STAGES = [
  "resolve_group",
  "resolve_source",
  "duplicate",
  "entry",
  "initialize",
  "autosave",
  "upload",
  "module",
  "section",
  "layout",
  "materialize",
  "metadata",
  "verify",
] as const;
export interface DraftProgress {
  readonly stage: (typeof DRAFT_STAGES)[number];
  readonly completedStages: readonly (typeof DRAFT_STAGES)[number][];
  readonly autosaveId?: string | undefined;
  readonly noteId?: string | undefined;
  readonly photoIds?: readonly string[] | undefined;
}

export type ErrorCode =
  | "group_not_found"
  | "everyone_not_found"
  | "group_ambiguous"
  | "coordination_failed"
  | "operation_failed"
  | "stale_session_state"
  | "operation_timeout"
  | "operation_cancelled"
  | "request_not_sent"
  | "draft_not_submitted"
  | "write_outcome_unknown"
  | "permission_denied"
  | "invalid_configuration"
  | "invalid_path"
  | "invalid_input"
  | "member_filter_unavailable"
  | "session_load_failed"
  | "invalid_session_state"
  | "session_save_failed"
  | "session_clear_failed"
  | "transport_failed"
  | "redirect_rejected"
  | "invalid_response"
  | "upstream_rejected"
  | "credentials_unavailable"
  | "credentials_rejected"
  | "authentication_required"
  | "action_required"
  | "authentication_unavailable"
  | "authentication_protocol_error";

/**
 * Public failure contract shared by resource models and adapters.
 * Keeps a fixed code, optional HTTP status and selected sanitized diagnostics.
 * The write outcome describes submission certainty and must survive adapter
 * translation, especially when completion is unknown.
 */
export class FlockbotError extends Error {
  readonly code: ErrorCode;
  readonly status?: number;
  readonly outcome: "not_submitted" | "unknown" | undefined;
  readonly response?: UpstreamResponse;
  readonly reason?: FailureReason;

  constructor(
    code: ErrorCode,
    status?: number,
    outcome?: "not_submitted" | "unknown",
    response?: UpstreamResponse,
    reason?: FailureReason,
    readonly draftProgress?: DraftProgress,
  ) {
    super(`Flockbot request failed (${code}).`);
    this.name = "FlockbotError";
    this.code = code;
    this.outcome =
      outcome ??
      (code === "write_outcome_unknown"
        ? "unknown"
        : code === "request_not_sent"
          ? "not_submitted"
          : undefined);
    if (
      typeof status === "number" &&
      Number.isInteger(status) &&
      status >= 100 &&
      status <= 599
    )
      this.status = status;
    const safeResponse = upstreamResponse(response);
    if (safeResponse) this.response = safeResponse;
    const safeReason = safeFailureReason(reason);
    if (safeReason) this.reason = safeReason;
  }
}

/**
 * An operation failed in a way that may indicate expired authentication.
 * Carries the original failure code so an adapter can diagnose the session after
 * failure. This signal alone does not establish expiry or permit request replay.
 */
export class AuthenticationSuspectedError extends FlockbotError {
  constructor(
    code:
      | "upstream_rejected"
      | "permission_denied"
      | "redirect_rejected"
      | "invalid_response",
    reason?: FailureReason,
    status?: number,
  ) {
    super(code, status, undefined, undefined, reason);
  }
}
