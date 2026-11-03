import {
  FlockbotError,
  type AddMemberResult,
  type MemberInput,
} from "../../src/index.js";
import { identifier } from "../../src/groups.js";
import { membershipRequest } from "../../src/members.js";

export const LIVE_VERIFICATION_CONSENT = "authorize-isolated-test-parish-run";

export interface VerificationTarget {
  readonly origin: string;
  readonly networkId: string;
}

/** Evidence must come from the same authenticated session used by this run. */
export interface TargetEvidence extends VerificationTarget {
  readonly authenticated: true;
}

/**
 * Source-only procedure seam. No live runner, transport, or credential loader is
 * provided. A later runner must reuse the shared client and establish the real
 * identity response shape before supplying evidence; configuration isn't proof.
 */
export interface VerificationExecution {
  readonly identifyTarget: (
    target: VerificationTarget,
  ) => Promise<TargetEvidence | null>;
  readonly listGroups: (
    target: VerificationTarget,
  ) => Promise<readonly { readonly id: string }[]>;
  readonly addMember: (
    target: VerificationTarget,
    groupId: string,
    member: MemberInput,
  ) => Promise<AddMemberResult>;
}

type GuardCode =
  | "consent_required"
  | "invalid_verification_config"
  | "group_not_allowlisted"
  | "target_unconfirmed"
  | "target_mismatch"
  | "group_unavailable"
  | "verification_read_failed"
  | "verification_write_failed";

export class VerificationError extends Error {
  readonly code: GuardCode;
  readonly outcome: "not_submitted" | "unknown";
  readonly upstreamCode: FlockbotError["code"] | undefined;

  constructor(
    code: GuardCode,
    outcome: "not_submitted" | "unknown" = "not_submitted",
    upstreamCode?: FlockbotError["code"],
  ) {
    super(`Isolated verification stopped (${code}).`);
    this.name = "VerificationError";
    this.code = code;
    this.outcome = outcome;
    this.upstreamCode = upstreamCode;
  }
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new VerificationError("invalid_verification_config");
  return value as Record<string, unknown>;
}

function snapshot(value: unknown) {
  try {
    const input = object(value);
    if (input.consent !== LIVE_VERIFICATION_CONSENT)
      throw new VerificationError("consent_required");
    const subdomain = input.subdomain;
    const operation = input.operation;
    if (
      typeof subdomain !== "string" ||
      !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(subdomain) ||
      input.testOnlyLoginConfirmed !== true ||
      (operation !== "read-groups" && operation !== "add-member")
    )
      throw new VerificationError("invalid_verification_config");
    const target = Object.freeze({
      origin: `https://${subdomain}.flocknote.com`,
      networkId: identifier(input.expectedNetworkId),
    });
    if (!Array.isArray(input.allowedGroupIds) || !input.allowedGroupIds.length)
      throw new VerificationError("invalid_verification_config");
    const allowed = input.allowedGroupIds.map(identifier);
    const groupId = identifier(input.groupId);
    if (!allowed.includes(groupId))
      throw new VerificationError("group_not_allowlisted");
    let member: Readonly<MemberInput> | undefined;
    if (operation === "add-member") {
      if (input.fictionalRecordConfirmed !== true)
        throw new VerificationError("invalid_verification_config");
      const record = object(input.member);
      if (
        typeof record.firstName !== "string" ||
        typeof record.lastName !== "string" ||
        typeof record.email !== "string" ||
        record.mobilePhone !== undefined
      )
        throw new VerificationError("invalid_verification_config");
      // The initial procedure permits email-only fictional records. Mobile and
      // message delivery need a separately reviewed controlled-recipient plan.
      member = Object.freeze({
        firstName: record.firstName,
        lastName: record.lastName,
        email: record.email,
      });
      membershipRequest(groupId, member);
    }
    return Object.freeze({ target, groupId, operation, member });
  } catch (error) {
    if (error instanceof VerificationError) throw error;
    throw new VerificationError("invalid_verification_config");
  }
}

/**
 * One explicitly authorized attempt: identify, list, optionally add once.
 * Identification is the only permitted call before target confirmation.
 * This does not enable writes in the packaged Zapier candidate.
 */
export async function runIsolatedVerification(
  input: unknown,
  execution: VerificationExecution,
): Promise<{ readonly verified: true; readonly writeConfirmed: boolean }> {
  const plan = snapshot(input);
  // Capture callbacks before the first await, as well as all target/input data.
  let identify: VerificationExecution["identifyTarget"];
  let list: VerificationExecution["listGroups"];
  let add: VerificationExecution["addMember"];
  try {
    identify = execution.identifyTarget.bind(execution);
    list = execution.listGroups.bind(execution);
    add = execution.addMember.bind(execution);
  } catch {
    throw new VerificationError("invalid_verification_config");
  }
  let evidence: TargetEvidence | null;
  try {
    evidence = await identify(plan.target);
    if (
      evidence?.authenticated !== true ||
      typeof evidence.origin !== "string" ||
      typeof evidence.networkId !== "string"
    )
      throw new VerificationError("target_unconfirmed");
    if (
      evidence.origin !== plan.target.origin ||
      evidence.networkId !== plan.target.networkId
    )
      throw new VerificationError("target_mismatch");
  } catch (error) {
    if (error instanceof VerificationError) throw error;
    throw new VerificationError("target_unconfirmed");
  }
  try {
    const groups = await list(plan.target);
    if (!groups.some((group) => identifier(group.id) === plan.groupId))
      throw new VerificationError("group_unavailable");
  } catch (error) {
    if (error instanceof VerificationError) throw error;
    throw new VerificationError("verification_read_failed");
  }
  if (plan.operation === "read-groups")
    return Object.freeze({ verified: true, writeConfirmed: false });
  try {
    const result = await add(
      plan.target,
      plan.groupId,
      plan.member as MemberInput,
    );
    if (result?.success !== true) throw new Error();
    return Object.freeze({ verified: true, writeConfirmed: true });
  } catch (error) {
    throw new VerificationError(
      "verification_write_failed",
      error instanceof FlockbotError && error.outcome === "not_submitted"
        ? "not_submitted"
        : "unknown",
      error instanceof FlockbotError ? error.code : undefined,
    );
  }
}
