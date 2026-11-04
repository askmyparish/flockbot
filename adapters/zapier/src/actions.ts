import {
  FlockbotClient,
  FlockbotError,
  type GroupAttributes,
  type MemberInput,
  type SessionCoordinator,
  type SessionStore,
  type Transport,
} from "../../../src/index.js";
import { failureSummary, type MembershipFailure } from "./failures.js";
import { membershipRequest } from "../../../src/members.js";
import { identifier } from "../../../src/groups.js";
import {
  createReadExecution,
  mappedError,
  runOperationalWrite,
  type AdapterTestDependencies,
  type HostBundle,
  type HostErrors,
} from "./authentication.js";
import {
  CLIENT_POLICY,
  CONFIGURATION_VERSION,
  REQUEST_TIMEOUT_MS,
} from "./policy.js";

/** Offline model boundary only; never a deployment readiness switch. */
export interface ModeledMembershipDependencies {
  readonly transport: Transport;
  readonly sessionStore: SessionStore;
  readonly coordinator: SessionCoordinator;
}

export interface CandidateTestDependencies {
  readonly read?: AdapterTestDependencies;
  readonly modeledMembership?: ModeledMembershipDependencies;
}

export interface GroupChoice {
  readonly id: string;
  readonly name: string;
  readonly short_name: string;
  readonly is_everyone: boolean;
}

/** One overall budget, including lookup and core preflight before a write. */
export async function withinActionDeadline<T>(
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    controller.abort();
  }, REQUEST_TIMEOUT_MS);
  try {
    return await work(controller.signal);
  } catch (error) {
    if (expired) {
      throw new FlockbotError(
        "operation_timeout",
        undefined,
        error instanceof FlockbotError ? error.outcome : undefined,
        error instanceof FlockbotError ? error.response : undefined,
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

export function actionError(
  z: HostErrors,
  error: unknown,
  report?: MembershipFailure,
): Error {
  if (
    (error instanceof FlockbotError && error.outcome === "unknown") ||
    report?.outcome === "unknown"
  ) {
    const message = report
      ? failureSummary(report)
      : `Flockbot membership completion is unknown (${error instanceof FlockbotError ? error.code : "write_outcome_unknown"}). Check Flocknote before any manual repeat. Automatic replay is stopped.`;
    return new z.errors.HaltedError(message);
  }
  // These fixed SDK errors were already mapped by the read-only execution.
  if (
    error instanceof z.errors.Error ||
    error instanceof z.errors.RefreshAuthError ||
    error instanceof z.errors.ExpiredAuthError ||
    error instanceof z.errors.HaltedError
  )
    return error;
  if (error instanceof FlockbotError) {
    if (["credentials_rejected", "action_required"].includes(error.code))
      return mappedError(z, error);
    const message =
      error.code === "invalid_input"
        ? report?.stage === "group_lookup"
          ? "The selected group is unavailable. Refresh the group choice"
          : "Check the mapped group, name and contact fields"
        : error.code === "permission_denied"
          ? "The Flocknote login lacks permission for this action"
          : error.code === "credentials_unavailable"
            ? "Flocknote authentication could not be completed. Check the connection before retrying"
            : error.code === "operation_timeout"
              ? "The Flocknote action timed out before member submission"
              : "Flockbot could not complete this action";
    return new z.errors.Error(
      `${message} (${error.code}${report ? `; stage=${report.stage}` : ""}).${report ? ` Attempt ${report.attempt_id}.` : ""}`,
      error.code,
      error.status ?? 400,
    );
  }
  return new z.errors.Error(
    "Flockbot could not complete this action (adapter_failed).",
    "adapter_failed",
    500,
  );
}

function choices(groups: readonly GroupAttributes[]): GroupChoice[] {
  return groups
    .map(({ id, name, shortName, isEveryone }) => ({
      id,
      name,
      short_name: shortName,
      is_everyone: isEveryone,
    }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export function memberRequest(bundle: HostBundle): {
  groupId: string;
  member: MemberInput;
} {
  try {
    const input = bundle.inputData;
    if (
      typeof input.user_first_name !== "string" ||
      typeof input.user_last_name !== "string"
    )
      throw new Error("Invalid member names.");
    for (const value of [input.user_email, input.user_mobile_phone])
      if (value !== undefined && value !== null && typeof value !== "string")
        throw new Error("Invalid contact field.");
    const member: MemberInput = {
      firstName: input.user_first_name,
      lastName: input.user_last_name,
      email: input.user_email as string | null | undefined,
      mobilePhone: input.user_mobile_phone as string | null | undefined,
    };
    membershipRequest(input.group_id, member);
    return {
      groupId: identifier(input.group_id),
      member,
    };
  } catch {
    throw new FlockbotError("invalid_input", undefined, "not_submitted");
  }
}

async function modeledMembership(
  z: HostErrors,
  bundle: HostBundle,
  model: ModeledMembershipDependencies,
  request: ReturnType<typeof memberRequest>,
  signal: AbortSignal,
) {
  let credentialReads = 0;
  const subdomain = bundle.authData.subdomain;
  if (typeof subdomain !== "string")
    throw new FlockbotError("invalid_configuration");
  const client = new FlockbotClient({
    subdomain,
    configurationVersion: CONFIGURATION_VERSION,
    sessionStore: model.sessionStore,
    coordinator: model.coordinator,
    transport: model.transport,
    policy: CLIENT_POLICY,
    credentialProvider: {
      load: async () => {
        if (++credentialReads > 1)
          throw new Error("Action renewal budget exhausted.");
        const { email, password } = bundle.authData;
        if (typeof email !== "string" || typeof password !== "string")
          throw new Error("Protected connection credentials are missing.");
        return { email, password };
      },
    },
  });
  const groups = await client.groups({ signal });
  if (!groups.some((group) => group.id === request.groupId))
    throw new z.errors.Error(
      "The selected group is unavailable. Refresh the group choice (invalid_input).",
      "invalid_input",
      400,
    );
  return client.addMember(request.groupId, request.member, { signal });
}

export function createActions(dependencies: CandidateTestDependencies = {}) {
  return {
    triggers: {
      group_choices: {
        key: "group_choices",
        noun: "Group",
        display: {
          label: "Group Choices",
          description: "Lists parish groups for the membership action.",
          hidden: true,
        },
        operation: {
          type: "polling" as const,
          perform: async (z: HostErrors, bundle: HostBundle) => {
            try {
              return await withinActionDeadline(async (signal) =>
                choices(
                  await createReadExecution(
                    z,
                    bundle,
                    dependencies.read,
                  ).groups({ signal }),
                ),
              );
            } catch (error) {
              throw actionError(z, error);
            }
          },
          sample: {
            id: "101",
            name: "Everyone",
            short_name: "everyone",
            is_everyone: true,
          },
          outputFields: [
            { key: "id", type: "string" as const },
            { key: "name", type: "string" as const },
            { key: "short_name", type: "string" as const },
            { key: "is_everyone", type: "boolean" as const },
          ],
        },
      },
    },
    creates: {
      add_member: {
        key: "add_member",
        noun: "Group Membership",
        display: {
          label: "Add Member to Group",
          description:
            "Adds a member to a parish group. Candidate writes remain blocked pending host verification.",
        },
        operation: {
          perform: async (z: HostErrors, bundle: HostBundle) => {
            try {
              const request = memberRequest(bundle);
              const model = dependencies.modeledMembership;
              if (!model)
                return await runOperationalWrite(z, async () => undefined);
              return await withinActionDeadline((signal) =>
                modeledMembership(z, bundle, model, request, signal),
              );
            } catch (error) {
              throw actionError(z, error);
            }
          },
          inputFields: [
            {
              key: "group_id",
              label: "Group",
              type: "string" as const,
              required: true,
              dynamic: "group_choices.id.name",
            },
            {
              key: "user_first_name",
              label: "First name",
              type: "string" as const,
              required: true,
            },
            {
              key: "user_last_name",
              label: "Last name",
              type: "string" as const,
              required: true,
            },
            {
              key: "user_email",
              label: "Email",
              type: "string" as const,
              required: false,
            },
            {
              key: "user_mobile_phone",
              label: "Mobile phone",
              type: "string" as const,
              required: false,
            },
          ],
          sample: { success: true },
          outputFields: [{ key: "success", type: "boolean" as const }],
        },
      },
    },
  };
}
