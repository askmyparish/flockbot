import { createHash } from "node:crypto";
import { version, type App } from "zapier-platform-core";
import {
  FlockbotClient,
  FlockbotError,
  RequestNotSentError,
  fetchTransport,
  type Transport,
} from "../../../src/index.js";
import {
  createAuthentication,
  decode,
  InvocationCoordinator,
  InvocationStore,
  type HostBundle,
  type HostErrors,
} from "./authentication.js";

export const MEMBERSHIP_TEST_CONSENT = "authorize-one-test-member";

/** Private deployment configuration, never a production readiness flag. */
export interface MembershipTestPlan {
  readonly subdomain: string;
  readonly networkId: string;
  readonly groupId: string;
  readonly emailDigest: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

function stopped(): never {
  throw new FlockbotError("invalid_configuration", undefined, "not_submitted");
}

export function testPlan(input: MembershipTestPlan): MembershipTestPlan {
  try {
    const plan = Object.freeze({ ...input });
    if (
      typeof plan.subdomain !== "string" ||
      !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(plan.subdomain) ||
      typeof plan.networkId !== "string" ||
      !/^[1-9][0-9]*$/.test(plan.networkId) ||
      typeof plan.groupId !== "string" ||
      !/^[1-9][0-9]*$/.test(plan.groupId) ||
      typeof plan.emailDigest !== "string" ||
      !/^[a-f0-9]{64}$/.test(plan.emailDigest) ||
      !Number.isSafeInteger(plan.createdAt) ||
      !Number.isSafeInteger(plan.expiresAt) ||
      plan.createdAt > Date.now() ||
      plan.expiresAt <= Date.now() ||
      plan.expiresAt <= plan.createdAt ||
      plan.expiresAt - plan.createdAt > 30 * 60_000
    )
      return stopped();
    return plan;
  } catch {
    return stopped();
  }
}

function recipient(
  plan: MembershipTestPlan,
  bundle: HostBundle,
  setup = false,
) {
  testPlan(plan);
  const values = setup
    ? { ...bundle.authData, ...bundle.inputData }
    : bundle.authData;
  if (
    values.subdomain !== plan.subdomain ||
    typeof values.testEmail !== "string"
  )
    return stopped();
  const email = values.testEmail.trim();
  if (
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    createHash("sha256").update(email).digest("hex") !== plan.emailDigest
  )
    return stopped();
  return email;
}

/**
 * Separate verification entry only. One manual invocation is authorized;
 * invocation-local state provides no distributed one-shot or durability claim.
 */
export function createMembershipVerificationApp(
  input: MembershipTestPlan,
  transport: Transport = fetchTransport,
) {
  // Do not reject an expired plan at module load: the host must load the schema
  // so it can display the fixed refusal rather than a runtime-load failure.
  const plan = Object.freeze({ ...input });
  const auth = createAuthentication({ transport });
  const creates = {
    add_member_test: {
      key: "add_member_test",
      noun: "Test Membership",
      display: {
        label: "Add One Configured Test Member",
        description:
          "Manually tests one configured fictional person and test group. Not for production Zaps.",
      },
      operation: {
        perform: async (z: HostErrors, bundle: HostBundle) => {
          let submitted = false;
          let stage = "configuration";
          const controller = new AbortController();
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            const email = recipient(plan, bundle);
            stage = "consent";
            if (
              bundle.inputData.consent !== MEMBERSHIP_TEST_CONSENT ||
              Object.keys(bundle.inputData).some((key) => key !== "consent")
            )
              stopped();
            timer = setTimeout(
              () => controller.abort(),
              Math.min(20_000, plan.expiresAt - Date.now()),
            );
            const origin = `https://${plan.subdomain}.flocknote.com`;
            let requests = 0;
            const bounded: Transport = async (request) => {
              const url = new URL(request.url);
              if (
                controller.signal.aborted ||
                Date.now() >= plan.expiresAt ||
                requests >= 8 ||
                url.origin !== origin ||
                url.search ||
                url.hash ||
                (request.method === "GET"
                  ? ![
                      "/user/userData",
                      "/dashboard",
                      "/navigation/groups",
                      "/network/getMetadata",
                    ].includes(url.pathname)
                  : submitted ||
                    url.pathname !== `/group/${plan.groupId}/addToGroupByAdmin`)
              )
                throw new RequestNotSentError();
              requests++;
              if (request.method === "POST") submitted = true;
              return transport(request);
            };
            stage = "saved_session";
            const state = decode(bundle.authData.sessionData);
            if (!state || state.origin !== origin) stopped();
            const client = new FlockbotClient({
              subdomain: plan.subdomain,
              sessionStore: new InvocationStore(state),
              coordinator: new InvocationCoordinator(),
              transport: bounded,
              policy: { timeoutMs: 20_000, maxReadRetries: 0 },
              // Deliberately no credential provider: this action cannot log in.
            });
            const options = { signal: controller.signal };
            stage = "authentication";
            await client.connect(options);
            stage = "network_identity";
            const identity = (await client.get(
              "network/getMetadata",
              options,
            )) as { networkID?: unknown };
            const observed = identity?.networkID;
            if (
              (typeof observed !== "string" &&
                !(
                  typeof observed === "number" &&
                  Number.isSafeInteger(observed) &&
                  observed > 0
                )) ||
              String(observed) !== plan.networkId
            )
              stopped();
            stage = "group_lookup";
            const groups = await client.groups(options);
            if (!groups.some((group) => group.id === plan.groupId)) stopped();
            stage = "membership_preflight";
            return await client.addMember(
              plan.groupId,
              { firstName: "Flockbot", lastName: "Verification", email },
              options,
            );
          } catch (error) {
            const code =
              error instanceof FlockbotError ? error.code : "adapter_failed";
            if (submitted)
              throw new z.errors.HaltedError(
                `Test membership completion is unknown (${code}). Inspect Flocknote before any repeat.`,
              );
            throw new z.errors.Error(
              `Isolated membership test stopped before submission (${code}; stage=${stage}).`,
              code,
              400,
            );
          } finally {
            if (timer !== undefined) clearTimeout(timer);
            controller.abort();
          }
        },
        inputFields: [
          {
            key: "consent",
            label: "Authorize the configured test member once",
            required: true,
            choices: [MEMBERSHIP_TEST_CONSENT],
          },
        ],
        sample: { success: true },
        outputFields: [{ key: "success", type: "boolean" as const }],
      },
    },
  };
  return {
    version: "2.0.1",
    platformVersion: version,
    triggers: {},
    flags: { skipHttpPatch: true },
    authentication: {
      ...auth,
      fields: [
        ...auth.fields,
        {
          key: "testEmail",
          label: "Approved controlled test email",
          type: "password" as const,
          required: true,
          isNoSecret: false,
        },
      ],
      sessionConfig: {
        perform: async (z: HostErrors, bundle: HostBundle) => {
          try {
            recipient(plan, bundle, true);
          } catch {
            throw new z.errors.Error(
              "The isolated test configuration is invalid or expired.",
              "invalid_configuration",
              400,
            );
          }
          return auth.sessionConfig.perform(z, bundle);
        },
      },
      test: async (z: HostErrors, bundle: HostBundle) => {
        try {
          recipient(plan, bundle);
        } catch {
          throw new z.errors.Error(
            "The isolated test configuration is invalid or expired.",
            "invalid_configuration",
            400,
          );
        }
        return auth.test(z, bundle);
      },
    },
    creates,
  } satisfies App<Record<string, never>, typeof creates>;
}
