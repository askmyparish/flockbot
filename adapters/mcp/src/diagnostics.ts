import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { FlockbotError, type ErrorCode } from "../../../src/errors.js";
import { FAILURE_REASONS } from "../../../src/failure-reason.js";
import type { BrowserConnectionError } from "./browser-runtime.js";
import { MCP_VERSION } from "./version.js";
import {
  sanitizePayload,
  payloadSchema,
  safePayload,
} from "./diagnostic-payload.js";

const operations = [
  "status",
  "connect",
  "groups",
  "subscriber_count",
  "find_members",
  "find_notes",
  "note",
  "member",
  "member_groups",
  "email_analytics",
  "group_notes",
  "member_latest_email_status",
  "member_communication_status",
  "group_members",
  "is_member",
  "add_member",
  "forget",
  "ping",
  "shutdown",
] as const;
export type DiagnosticOperation = (typeof operations)[number];
type DiagnosticCode =
  | ErrorCode
  | BrowserConnectionError["code"]
  | "connector_unavailable";
const codes = [
  "group_not_found",
  "everyone_not_found",
  "group_ambiguous",
  "coordination_failed",
  "operation_failed",
  "stale_session_state",
  "operation_timeout",
  "operation_cancelled",
  "request_not_sent",
  "write_outcome_unknown",
  "permission_denied",
  "invalid_configuration",
  "invalid_path",
  "invalid_input",
  "session_load_failed",
  "invalid_session_state",
  "session_save_failed",
  "session_clear_failed",
  "transport_failed",
  "redirect_rejected",
  "invalid_response",
  "upstream_rejected",
  "credentials_unavailable",
  "credentials_rejected",
  "authentication_required",
  "action_required",
  "authentication_unavailable",
  "authentication_protocol_error",
  "browser_unavailable",
  "profile_unavailable",
  "not_configured",
  "connection_busy",
  "connection_changed",
  "broker_unavailable",
  "connector_unavailable",
] as const satisfies readonly DiagnosticCode[];
// Requiring every enum entry catches missing codes as well as invalid extras.
const codeSchema: z.ZodEnum<{ [Code in DiagnosticCode]: Code }> = z.enum(codes);
const endpoints = [
  "unknown",
  "user/userData",
  "dashboard",
  "navigation/groups",
  "network/getMetadata",
  "supersearch/query",
  "composer/editNote",
  "group/{id}/getSubscriberCount",
  "group/{id}/addToGroupByAdmin",
  "group/{id}/notes",
  "group/{id}/people",
  "group/{id}/people/{offset}",
  "group/{id}/filter",
  "user/{id}/profile",
  "user/{id}/groups",
  "note/{id}/analyticsSummary",
  "note/{id}/analytics2",
  "note/{id}/searchAnalytics",
] as const;
const boundedNumber = z.number().finite().min(0).max(Number.MAX_SAFE_INTEGER);
const eventSchema = z.object({
  stage: z.enum(["transport", "validation", "connection", "broker", "tool"]),
  phase: z.enum(["operation", "authentication"]),
  elapsedMs: boundedNumber,
  code: codeSchema.optional(),
  reason: z.enum(FAILURE_REASONS).optional(),
  endpoint: z.enum(endpoints).optional(),
  method: z.enum(["GET", "POST"]).optional(),
  status: z.number().int().min(100).max(599).optional(),
  contentType: z.enum(["json", "html", "text", "other", "missing"]).optional(),
  bytes: boundedNumber.optional(),
});
type DiagnosticEvent = z.infer<typeof eventSchema>;
const identitySchema = z.object({
  version: z
    .string()
    .max(64)
    .regex(/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/),
  fingerprint: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
});
const authSchema = z.enum([
  "not_attempted",
  "authenticated",
  "sign_in_required",
  "denied",
  "inconclusive",
]);
export const diagnosticSchema = z.object({
  version: z.literal(1),
  operationId: z.string().uuid(),
  observedAt: z.string().datetime(),
  operation: z.enum(operations),
  runtime: identitySchema,
  browserRuntime: identitySchema.nullable(),
  authentication: authSchema,
  events: z.array(eventSchema).max(30),
  failure: eventSchema,
  final: eventSchema,
  truncated: z.boolean(),
  traceSaved: z.boolean(),
});
export type FailureDiagnostic = z.infer<typeof diagnosticSchema>;

const exchangeSchema = z.object({
  event: eventSchema,
  request: payloadSchema,
  response: payloadSchema,
});
const verboseSchema = diagnosticSchema
  .pick({
    operationId: true,
    observedAt: true,
    operation: true,
    runtime: true,
    browserRuntime: true,
    truncated: true,
    traceSaved: true,
  })
  .extend({
    version: z.literal(2),
    kind: z.literal("verbose"),
    outcome: z.enum(["success", "failure"]),
    available: z.boolean(),
    exchanges: z.array(exchangeSchema).max(30),
    diagnostic: diagnosticSchema.optional(),
  });
export type VerboseDiagnostic = z.infer<typeof verboseSchema>;

// Bundling makes import.meta.url the complete running server, including models.
// Source-mode tests do not claim a single-module hash identifies the whole build.
export const diagnosticRuntime = (() => {
  let fingerprint: string | null = null;
  try {
    if (import.meta.url.endsWith("/index.mjs"))
      fingerprint = createHash("sha256")
        .update(readFileSync(new URL(import.meta.url)))
        .digest("hex");
  } catch {
    /* An unavailable identity never prevents an operation. */
  }
  return Object.freeze({ version: MCP_VERSION, fingerprint });
})();

interface Trace {
  operationId: string;
  operation: DiagnosticOperation;
  observedAt: string;
  started: number;
  phase: DiagnosticEvent["phase"];
  authentication: FailureDiagnostic["authentication"];
  events: DiagnosticEvent[];
  failure?: DiagnosticEvent;
  remote?: FailureDiagnostic;
  browser: boolean;
  truncated: boolean;
  validationResponse?: DiagnosticEvent | undefined;
  verbose: boolean;
  exchanges: VerboseDiagnostic["exchanges"];
  remoteVerbose?: VerboseDiagnostic;
  verboseAvailable: boolean;
}
const traces = new AsyncLocalStorage<Trace>();
const responsePaths = new WeakMap<DiagnosticEvent, string>();
const errorResponses = new WeakMap<Error, DiagnosticEvent>();

export function runDiagnostic<T>(
  operation: DiagnosticOperation,
  work: () => T,
  operationId?: string,
  browser = false,
  verbose = false,
): T {
  const suppliedId = z.string().uuid().safeParse(operationId);
  return traces.run(
    {
      operationId: suppliedId.success ? suppliedId.data : randomUUID(),
      operation,
      observedAt: new Date().toISOString(),
      started: performance.now(),
      phase: "operation",
      authentication: "not_attempted",
      events: [],
      browser,
      truncated: false,
      verbose,
      exchanges: [],
      verboseAvailable: true,
    },
    work,
  );
}

export function diagnosticOperationId(): string | undefined {
  return traces.getStore()?.operationId;
}

export function verboseDiagnosticsEnabled(): boolean {
  return traces.getStore()?.verbose === true;
}

function endpoint(path: string): (typeof endpoints)[number] {
  if (
    [
      "user/userData",
      "dashboard",
      "navigation/groups",
      "network/getMetadata",
    ].includes(path)
  )
    return path as (typeof endpoints)[number];
  // Only a complete known route is normalized. Never echo unknown path text.
  const normalized = path
    .replace(/^(group|user|note)\/[A-Za-z0-9_-]+(?=\/|\?|$)/, "$1/{id}")
    .replace(/\/people\/[1-9]\d{0,15}\?ajax&more$/, "/people/{offset}")
    .replace(/\/notes\?ajax&more$/, "/notes")
    .replace(/\?ajax$/, "");
  return endpoints.find((entry) => entry === normalized) ?? "unknown";
}

export function recordResponse(
  path: string,
  method: "GET" | "POST",
  metadata: unknown,
  elapsedMs: number,
  requestBody?: string,
): DiagnosticEvent | undefined {
  const trace = traces.getStore();
  if (!trace) return;
  const data =
    typeof metadata === "object" && metadata !== null ? metadata : {};
  const parsed = eventSchema.safeParse({
    ...data,
    stage: "transport",
    phase: trace.phase,
    endpoint: endpoint(path),
    method,
    elapsedMs,
  });
  if (!parsed.success) return;
  if (trace.events.length === 30) {
    trace.events.shift();
    trace.truncated = true;
  }
  trace.events.push(parsed.data);
  responsePaths.set(parsed.data, path);
  trace.validationResponse = parsed.data;
  if (trace.verbose) {
    try {
      const response = data as { data?: unknown; contentType?: string };
      const auth =
        trace.phase === "authentication" ||
        path === "user/userData" ||
        trace.operation === "connect";
      const omitted = { state: "omitted", reason: "authentication" } as const;
      trace.exchanges.push({
        event: parsed.data,
        request: auth ? omitted : sanitizePayload(requestBody, "form"),
        response: auth
          ? omitted
          : sanitizePayload(response.data, response.contentType ?? "missing"),
      });
      boundExchanges(trace);
    } catch {
      trace.verboseAvailable = false;
    }
  }
  return parsed.data;
}

function boundExchanges(trace: Trace): void {
  if (
    trace.exchanges.some((entry) =>
      [entry.request, entry.response].some((payload) =>
        payload.state === "omitted"
          ? payload.reason === "limit"
          : payload.truncated === true,
      ),
    )
  )
    trace.truncated = true;
  while (trace.exchanges.length > 30) {
    trace.exchanges.shift();
    trace.truncated = true;
  }
  while (Buffer.byteLength(JSON.stringify(trace.exchanges)) > 12 * 1024) {
    // Keep event provenance even when its bodies exceed the operation budget.
    const full = trace.exchanges.find(
      (entry) =>
        entry.request.state === "captured" ||
        entry.response.state === "captured",
    );
    if (full) {
      full.request = { state: "omitted", reason: "limit" };
      full.response = { state: "omitted", reason: "limit" };
    } else trace.exchanges.shift();
    trace.truncated = true;
  }
}

/** Bind the exact request before concurrent requests can finish in another order. */
export function responseError<T extends Error>(
  error: T,
  response: DiagnosticEvent | undefined,
): T {
  if (response) errorResponses.set(error, response);
  return error;
}

/** Models revisiting an earlier response explicitly select its provenance. */
export function validationSource(path: string): void {
  const trace = traces.getStore();
  if (trace)
    trace.validationResponse = [...trace.events]
      .reverse()
      .find((event) => responsePaths.get(event) === path);
}

export function validationError(error: unknown, path: string): void {
  validationSource(path);
  const response = traces.getStore()?.validationResponse;
  if (error instanceof Error && response)
    responseError(error, { ...response, stage: "validation" });
}

const transportReasons = new Set([
  "origin_mismatch",
  "missing_response_body",
  "response_too_large",
  "invalid_json",
  "empty_response",
  "redirect",
  "http_rejection",
  "request_timeout",
  "fetch_failed",
  "evaluation_failed",
]);

function errorEvent(error: unknown, trace: Trace): DiagnosticEvent {
  let raw: { code?: unknown; reason?: unknown; status?: unknown } = {};
  try {
    if (error instanceof Error) {
      const candidate = error as Error & {
        code?: unknown;
        reason?: unknown;
        status?: unknown;
      };
      raw = {
        code: candidate.code,
        reason: candidate.reason,
        status: candidate.status,
      };
    }
  } catch {
    /* Exception accessors are not diagnostic data. */
  }
  const code = codeSchema.safeParse(raw.code);
  const reason = z.enum(FAILURE_REASONS).safeParse(raw.reason);
  const status = eventSchema.shape.status.safeParse(raw.status);
  return {
    stage:
      reason.success && transportReasons.has(reason.data)
        ? "transport"
        : raw.code === "broker_unavailable" || raw.code === "connection_busy"
          ? "broker"
          : error instanceof FlockbotError && reason.success
            ? "validation"
            : trace.browser
              ? "connection"
              : "tool",
    phase: trace.phase,
    elapsedMs: Math.max(0, performance.now() - trace.started),
    code: code.success ? code.data : "connector_unavailable",
    ...(reason.success
      ? { reason: reason.data }
      : !code.success
        ? { reason: "unknown_failure" }
        : {}),
    ...(status.success && status.data !== undefined
      ? { status: status.data }
      : {}),
  };
}

/** Freeze the original failure before an existing auth check can replace it. */
export function captureFailure(error: unknown): void {
  const trace = traces.getStore();
  if (!trace || trace.failure) return;
  const event = errorEvent(error, trace);
  const response =
    error instanceof Error ? errorResponses.get(error) : undefined;
  trace.failure = response
    ? {
        ...response,
        code: event.code,
        ...(event.reason ? { reason: event.reason } : {}),
      }
    : event.stage === "validation" && trace.validationResponse
      ? { ...trace.validationResponse, ...event }
      : event;
}

export function beginAuthDiagnosis(): void {
  const trace = traces.getStore();
  if (trace) {
    trace.phase = "authentication";
    trace.authentication = "inconclusive";
  }
}
export function endAuthDiagnosis(
  result: FailureDiagnostic["authentication"],
): void {
  const trace = traces.getStore();
  if (trace) {
    trace.authentication = result;
    trace.phase = "operation";
  }
}

/** Treat IPC diagnostics as untrusted and strip everything outside the schema. */
export function safeDiagnostic(value: unknown): FailureDiagnostic | undefined {
  try {
    const parsed = diagnosticSchema.safeParse(value);
    if (
      parsed.success &&
      Buffer.byteLength(JSON.stringify(parsed.data)) <= 16 * 1024
    )
      return parsed.data;
  } catch {
    /* Ignore malformed diagnostics, not the primary result. */
  }
  return undefined;
}

export function receiveDiagnostic(value: unknown): void {
  const trace = traces.getStore();
  const diagnostic = safeDiagnostic(value);
  if (trace && diagnostic?.operationId === trace.operationId)
    trace.remote = diagnostic;
}

export function failureDiagnostic(error: unknown): FailureDiagnostic {
  const trace = traces.getStore();
  if (!trace) throw new Error("Diagnostic context required");
  captureFailure(error);
  const remote = trace.remote;
  const diagnostic: FailureDiagnostic = {
    version: 1,
    operationId: trace.operationId,
    observedAt: trace.observedAt,
    operation: trace.operation,
    runtime: diagnosticRuntime,
    browserRuntime: trace.browser
      ? diagnosticRuntime
      : (remote?.browserRuntime ?? null),
    authentication: remote?.authentication ?? trace.authentication,
    events: remote?.events ?? [...trace.events],
    failure: remote?.failure ?? trace.failure ?? errorEvent(error, trace),
    final: errorEvent(error, trace),
    truncated: remote?.truncated ?? trace.truncated,
    traceSaved: false,
  };
  while (
    Buffer.byteLength(JSON.stringify(diagnostic)) > 16 * 1024 &&
    diagnostic.events.length
  ) {
    diagnostic.events.shift();
    diagnostic.truncated = true;
  }
  return diagnostic;
}

export function safeVerboseDiagnostic(
  value: unknown,
): VerboseDiagnostic | undefined {
  try {
    const parsed = verboseSchema.safeParse(value);
    if (!parsed.success) return;
    const record = parsed.data;
    if (record.diagnostic) record.diagnostic.events = [];
    record.exchanges = record.exchanges.map((entry) => {
      const auth =
        entry.event.phase === "authentication" ||
        entry.event.endpoint === "user/userData" ||
        record.operation === "connect";
      const omitted = { state: "omitted", reason: "authentication" } as const;
      return {
        event: entry.event,
        request: auth ? omitted : safePayload(entry.request),
        response: auth ? omitted : safePayload(entry.response),
      };
    });
    record.truncated ||= record.exchanges.some((entry) =>
      [entry.request, entry.response].some(
        (payload) => payload.state === "captured" && payload.truncated === true,
      ),
    );
    if (Buffer.byteLength(JSON.stringify(record)) <= 16 * 1024) return record;
  } catch {
    /* Malformed payloads never replace the tool result. */
  }
  return undefined;
}

export function receiveVerboseDiagnostic(value: unknown): void {
  const trace = traces.getStore();
  if (!trace?.verbose) return;
  const record = safeVerboseDiagnostic(value);
  if (
    record?.operationId === trace.operationId &&
    (record.operation === trace.operation ||
      (trace.operation === "connect" && record.operation === "status"))
  ) {
    trace.remoteVerbose = record;
    trace.exchanges.push(...record.exchanges);
    trace.truncated ||= record.truncated;
    trace.verboseAvailable &&= record.available;
    boundExchanges(trace);
  } else trace.verboseAvailable = false;
}

export function verboseDiagnostic(
  outcome: "success" | "failure",
  diagnostic?: FailureDiagnostic,
): VerboseDiagnostic | undefined {
  try {
    const trace = traces.getStore();
    if (!trace?.verbose) return;
    const remote = trace.remoteVerbose;
    const record: VerboseDiagnostic = {
      version: 2,
      kind: "verbose",
      operationId: trace.operationId,
      observedAt: trace.observedAt,
      operation: trace.operation,
      runtime: diagnosticRuntime,
      browserRuntime: trace.browser
        ? diagnosticRuntime
        : (remote?.browserRuntime ?? diagnostic?.browserRuntime ?? null),
      outcome,
      available: trace.verboseAvailable && (remote?.available ?? true),
      exchanges: [...trace.exchanges],
      truncated: trace.truncated || (remote?.truncated ?? false),
      traceSaved: false,
      // Exchange events already carry the request history; retain only the two
      // failure/disposition events here to keep the 32-event operation bound.
      ...(diagnostic ? { diagnostic: { ...diagnostic, events: [] } } : {}),
    };
    while (
      Buffer.byteLength(JSON.stringify(record)) > 16 * 1024 &&
      record.exchanges.length
    ) {
      record.exchanges.shift();
      record.truncated = true;
    }
    return safeVerboseDiagnostic(record);
  } catch {
    // Capture failure must not turn a completed write into an operation error.
    return undefined;
  }
}

export function safeLogRecord(
  value: unknown,
): FailureDiagnostic | VerboseDiagnostic | undefined {
  return value &&
    typeof value === "object" &&
    "version" in value &&
    value.version === 2
    ? safeVerboseDiagnostic(value)
    : safeDiagnostic(value);
}
