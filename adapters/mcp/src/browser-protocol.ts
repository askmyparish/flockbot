import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { AsyncResource } from "node:async_hooks";
import net from "node:net";
import { z } from "zod";
import { FlockbotError } from "../../../src/index.js";
import { MAX_REQUEST_BYTES } from "../../../src/request-limits.js";
import {
  MEMBER_FILTER_PAGE_SIZE,
  MEMBER_OPERATORS,
} from "../../../src/models/member-filters.js";
import { DRAFT_STAGES, type DraftProgress } from "../../../src/errors.js";
import { BrowserConnectionError } from "./browser-runtime.js";
import {
  diagnosticOperationId,
  receiveDiagnostic,
  type FailureDiagnostic,
  receiveVerboseDiagnostic,
  verboseDiagnosticsEnabled,
  type VerboseDiagnostic,
} from "./diagnostics.js";
import {
  safeFailureReason,
  type FailureReason,
} from "../../../src/failure-reason.js";

export const MAX_REQUEST = MAX_REQUEST_BYTES;
export const MAX_RESPONSE = 2 * 1024 * 1024;
export const memberSearchShape = {
  mode: z.enum(["count", "members"]).optional(),
  searchTerm: z.string().min(1).max(256).optional(),
  groupId: z.string().min(1).max(128).optional(),
  groupName: z.string().min(1).max(256).optional(),
  fields: z
    .array(z.enum(["email", "mobilePhone", "joinedOn"]))
    .max(3)
    .optional(),
  limit: z.number().int().min(1).max(100).optional(),
  continuation: z
    .object({
      offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
      resultCount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
      queryKey: z.string().regex(/^[a-f0-9]{64}$/),
      previousPageKey: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict()
    .optional(),
  includeInactive: z.boolean().optional(),
  criteria: z
    .object({
      any: z
        .array(
          z
            .object({
              all: z
                .array(
                  z
                    .object({
                      fieldId: z.string().min(1).max(280),
                      operator: z.enum(MEMBER_OPERATORS),
                      value: z.string().min(1).max(256).optional(),
                      negated: z.boolean().optional(),
                    })
                    .strict(),
                )
                .min(1)
                .max(20)
                .readonly(),
            })
            .strict(),
        )
        .min(1)
        .max(8)
        .readonly(),
    })
    .strict()
    .optional(),
};
export const draftContentSchema = z
  .array(
    z.union([
      z
        .object({
          type: z.literal("text"),
          body: z.string().min(1),
          bodyFormat: z.enum(["text", "html"]).optional(),
        })
        .strict(),
      z
        .object({
          type: z.literal("button"),
          text: z.string().min(1),
          url: z.string().min(1),
        })
        .strict(),
      z.object({ type: z.literal("image"), path: z.string().min(1) }).strict(),
    ]),
  )
  .min(1)
  .readonly();
const draftProgressSchema = z
  .object({
    stage: z.enum(DRAFT_STAGES),
    completedStages: z.array(z.enum(DRAFT_STAGES)).max(DRAFT_STAGES.length),
    autosaveId: z
      .string()
      .regex(/^\d{1,128}$/)
      .optional(),
    noteId: z
      .string()
      .regex(/^\d{1,128}$/)
      .optional(),
    photoIds: z.array(z.string().regex(/^\d{1,128}$/)).optional(),
  })
  .strict();
export const brokerRequestSchema = z
  .discriminatedUnion("action", [
    z.object({ action: z.literal("ping") }).strict(),
    z.object({ action: z.literal("shutdown") }).strict(),
    z.object({ action: z.literal("status") }).strict(),
    z
      .object({
        action: z.literal("connect"),
        subdomain: z.string().min(1).max(63),
      })
      .strict(),
    z
      .object({ action: z.literal("groups"), refresh: z.boolean().optional() })
      .strict(),
    z
      .object({
        action: z.literal("count"),
        groupId: z.string().min(1).max(128),
      })
      .strict(),
    z
      .object({ action: z.literal("note"), noteId: z.string().min(1).max(128) })
      .strict(),
    z
      .object({
        action: z.literal("find_notes"),
        searchTerm: z.string().min(1).max(256),
      })
      .strict(),
    z
      .object({
        action: z.literal("member_filters"),
        groupId: z.string().min(1).max(128).optional(),
        groupName: z.string().min(1).max(256).optional(),
        fieldId: z.string().min(1).max(280).optional(),
        offset: z
          .number()
          .int()
          .min(0)
          .max(Number.MAX_SAFE_INTEGER - MEMBER_FILTER_PAGE_SIZE)
          .optional(),
      })
      .strict(),
    z
      .object({
        action: z.literal("find_members"),
        ...memberSearchShape,
      })
      .strict(),
    z
      .object({
        action: z.literal("member"),
        userId: z.string().min(1).max(128),
        fields: z
          .array(z.enum(["email", "mobilePhone"]))
          .max(2)
          .optional(),
      })
      .strict(),
    z
      .object({
        action: z.literal("member_groups"),
        userId: z.string().min(1).max(128),
      })
      .strict(),
    z
      .object({
        action: z.literal("group_notes"),
        groupId: z.string().min(1).max(128).optional(),
        groupName: z.string().min(1).max(256).optional(),
      })
      .strict(),
    z
      .object({
        action: z.literal("email_analytics"),
        emailId: z.string().min(1).max(128).optional(),
        groupId: z.string().min(1).max(128).optional(),
        groupName: z.string().min(1).max(256).optional(),
      })
      .strict(),
    z
      .object({
        action: z.literal("email_recipients"),
        emailId: z.string().min(1).max(128),
        category: z.enum(["opened", "unopened"]),
        fields: z.array(z.literal("address")).max(1).optional(),
      })
      .strict(),
    z
      .object({
        action: z.literal("member_latest_email_status"),
        userId: z.string().min(1).max(128),
        groupId: z.string().min(1).max(128).optional(),
        groupName: z.string().min(1).max(256).optional(),
      })
      .strict(),
    z
      .object({
        action: z.literal("member_communication_status"),
        userId: z.string().min(1).max(128),
        groupId: z.string().min(1).max(128).optional(),
        groupName: z.string().min(1).max(256).optional(),
        fields: z
          .array(z.enum(["email", "mobilePhone"]))
          .max(2)
          .optional(),
      })
      .strict(),
    z
      .object({
        action: z.literal("group_members"),
        groupId: z.string().min(1).max(128).optional(),
        groupName: z.string().min(1).max(256).optional(),
        offset: z
          .number()
          .int()
          .min(0)
          .max(Number.MAX_SAFE_INTEGER - 100)
          .optional(),
        fields: z
          .array(z.enum(["email", "mobilePhone", "joinedOn"]))
          .max(3)
          .optional(),
      })
      .strict(),
    z
      .object({
        action: z.literal("is_member"),
        userId: z.string().min(1).max(128),
        groupId: z.string().min(1).max(128).optional(),
        groupName: z.string().min(1).max(256).optional(),
      })
      .strict(),
    z
      .object({
        action: z.literal("add"),
        groupId: z.string().max(128).optional(),
        groupName: z.string().max(256).optional(),
        member: z
          .object({
            firstName: z.string().max(256),
            lastName: z.string().max(256),
            email: z.string().max(320).optional(),
            mobilePhone: z.string().max(64).optional(),
          })
          .strict(),
      })
      .strict(),
    z.object({ action: z.literal("forget") }).strict(),
    z
      .object({
        action: z.literal("duplicate_email_draft"),
        noteId: z.string().min(1).max(128),
      })
      .strict(),
    z
      .object({
        action: z.literal("create_email_draft"),
        groupId: z.string().min(1).max(128).optional(),
        groupName: z.string().min(1).max(256).optional(),
        subject: z.string().min(1),
        body: z.string().min(1).optional(),
        bodyFormat: z.enum(["text", "html"]).optional(),
        content: draftContentSchema.optional(),
      })
      .strict(),
  ])
  // Preserve legacy IPC shape rejection; MemberSearch owns mode validation
  // for every entry point, including the shared MCP input shape.
  .refine(
    (request) =>
      request.action !== "find_members" ||
      request.mode === "members" ||
      request.limit === undefined ||
      request.limit <= 50,
    { path: ["limit"], message: "Limits above 50 require mode members." },
  );
export type BrokerRequest = z.infer<typeof brokerRequestSchema>;
export function isWriteRequest(request: BrokerRequest): boolean {
  return (
    request.action === "add" ||
    request.action === "create_email_draft" ||
    request.action === "duplicate_email_draft"
  );
}
export interface BrokerDescriptor {
  version: 1;
  runtime: string;
  address: string;
  key: string;
}
export interface BrokerReply {
  nonce: string;
  value?: unknown;
  diagnostic?: FailureDiagnostic;
  verboseDiagnostic?: VerboseDiagnostic;
  error?: {
    kind: "flockbot" | "browser";
    code: string;
    status?: number;
    reason?: FailureReason;
    outcome?: "not_submitted" | "unknown";
    stage?: BrowserConnectionError["stage"];
    draftProgress?: DraftProgress;
  };
}

function tag(payload: string, key: string): string {
  return createHmac("sha256", Buffer.from(key, "hex"))
    .update(payload)
    .digest("hex");
}
export function encodeFrame(value: unknown, key: string): string {
  const payload = JSON.stringify(value);
  return `${JSON.stringify({ payload, mac: tag(payload, key) })}\n`;
}
export function decodeFrame(input: string, key: string): unknown {
  const envelope = JSON.parse(input) as { payload: string; mac: string };
  if (
    typeof envelope.payload !== "string" ||
    typeof envelope.mac !== "string" ||
    !/^[a-f0-9]{64}$/.test(envelope.mac) ||
    !timingSafeEqual(
      Buffer.from(envelope.mac, "hex"),
      Buffer.from(tag(envelope.payload, key), "hex"),
    )
  )
    throw new Error();
  return JSON.parse(envelope.payload) as unknown;
}

/** Same-user IPC only. Never sends the key itself, cookies, scripts or URLs. */
export async function requestBroker(
  descriptor: BrokerDescriptor,
  request: BrokerRequest,
  signal?: AbortSignal,
  timeoutMs = 35_000,
): Promise<unknown> {
  const nonce = randomBytes(32).toString("hex");
  const capture =
    verboseDiagnosticsEnabled() &&
    request.action !== "ping" &&
    request.action !== "shutdown";
  return new Promise((resolve, reject) => {
    let sent = false;
    let complete = false;
    let buffer = "";
    const socket = new net.Socket();
    socket.setEncoding("utf8");
    const fail = (cancelled = false) => {
      if (complete) return;
      complete = true;
      if (capture) receiveVerboseDiagnostic(undefined);
      socket.destroy();
      const outcome = isWriteRequest(request)
        ? sent
          ? "unknown"
          : "not_submitted"
        : undefined;
      reject(
        cancelled
          ? new FlockbotError("operation_cancelled", undefined, outcome)
          : new BrowserConnectionError("broker_unavailable", outcome),
      );
    };
    const onFailure = () => fail();
    // AbortSignal listeners run in the canceller's context, not this request's.
    const onAbort = AsyncResource.bind(() => fail(true));
    const finish = () => {
      signal?.removeEventListener("abort", onAbort);
    };
    socket.on("error", onFailure);
    socket.on("close", () => {
      finish();
      if (!complete) fail();
    });
    socket.setTimeout(timeoutMs, onFailure);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      finish();
      return;
    }
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_RESPONSE) {
        fail();
        return;
      }
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      try {
        const reply = decodeFrame(
          buffer.slice(0, end),
          descriptor.key,
        ) as BrokerReply;
        if (reply.nonce !== nonce) throw new Error();
        receiveDiagnostic(reply.diagnostic);
        if (capture) receiveVerboseDiagnostic(reply.verboseDiagnostic);
        let error: Error | undefined;
        if (reply.error) {
          if (
            !["flockbot", "browser"].includes(reply.error.kind) ||
            typeof reply.error.code !== "string"
          )
            throw new Error();
          error =
            reply.error.kind === "flockbot"
              ? new FlockbotError(
                  reply.error.code as FlockbotError["code"],
                  reply.error.status,
                  reply.error.outcome,
                  undefined,
                  safeFailureReason(reply.error.reason),
                  reply.error.draftProgress === undefined
                    ? undefined
                    : draftProgressSchema.parse(reply.error.draftProgress),
                )
              : new BrowserConnectionError(
                  reply.error.code as BrowserConnectionError["code"],
                  reply.error.outcome,
                  reply.error.stage,
                  reply.error.draftProgress === undefined
                    ? undefined
                    : draftProgressSchema.parse(reply.error.draftProgress),
                );
        }
        complete = true;
        finish();
        socket.destroy();
        if (error) reject(error);
        else resolve(reply.value);
      } catch {
        fail();
      }
    });
    try {
      socket.connect({ path: descriptor.address }, () => {
        if (complete) return;
        const frame = encodeFrame(
          {
            nonce,
            request,
            operationId: diagnosticOperationId(),
            verboseDiagnostics: capture,
          },
          descriptor.key,
        );
        if (Buffer.byteLength(frame) > MAX_REQUEST) {
          complete = true;
          finish();
          socket.destroy();
          reject(
            new FlockbotError(
              "request_not_sent",
              undefined,
              "not_submitted",
              undefined,
              "request_too_large",
            ),
          );
          return;
        }
        sent = true;
        socket.write(frame);
      });
    } catch {
      fail();
    }
  });
}
