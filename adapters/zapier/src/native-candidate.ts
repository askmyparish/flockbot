import { type App, version } from "zapier-platform-core";
import {
  FlockbotClient,
  FlockbotError,
  type Transport,
} from "../../../src/index.js";
import {
  actionError,
  createActions,
  memberRequest,
  withinActionDeadline,
} from "./actions.js";
import {
  createAuthentication,
  decode,
  InvocationCoordinator,
  InvocationStore,
  type HostBundle,
  type HostErrors,
} from "./authentication.js";
import { CLIENT_POLICY, CONFIGURATION_VERSION } from "./policy.js";

/** Isolated candidate; this does not replace the default app's write gate. */
export function createNativeCandidate(
  dependencies: { transport?: Transport } = {},
) {
  const base = createActions({ read: dependencies });
  const creates = {
    add_member: {
      ...base.creates.add_member,
      display: {
        label: "Add Member to Group",
        description: "Adds a member using the saved Flocknote connection.",
      },
      operation: {
        ...base.creates.add_member.operation,
        // Admission for this action only, not an authentication-hook mutex.
        lock: {
          key: "flockbot-membership",
          scope: ["auth" as const],
          timeout: 60,
        },
        perform: async (z: HostErrors, bundle: HostBundle) => {
          let renewalRequested = false;
          try {
            const request = memberRequest(bundle);
            return await withinActionDeadline(async (signal) => {
              const subdomain = bundle.authData.subdomain;
              if (typeof subdomain !== "string")
                throw new FlockbotError("invalid_configuration");
              const client = new FlockbotClient({
                subdomain,
                configurationVersion: CONFIGURATION_VERSION,
                sessionStore: new InvocationStore(
                  decode(bundle.authData.sessionData),
                ),
                coordinator: new InvocationCoordinator(),
                ...dependencies,
                policy: CLIENT_POLICY,
                credentialProvider: {
                  load: async () => {
                    // Missing/confirmed-invalid sessions reach this before POST.
                    // The host owns renewal and persistence through Session Auth.
                    renewalRequested = true;
                    throw new Error("Renewal belongs to Session Auth.");
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
              return client.addMember(request.groupId, request.member, {
                signal,
              });
            });
          } catch (error) {
            // Submitted errors always take the no-replay path, even if auth-like.
            if (
              error instanceof FlockbotError &&
              error.outcome !== "unknown" &&
              error.code === "credentials_unavailable" &&
              renewalRequested
            )
              throw new z.errors.RefreshAuthError(
                "The saved Flocknote session needs renewal before member submission.",
              );
            throw actionError(z, error);
          }
        },
      },
    },
  };
  return {
    version: "2.1.4",
    platformVersion: version,
    flags: { skipHttpPatch: true },
    authentication: createAuthentication(dependencies),
    triggers: base.triggers,
    creates,
  } satisfies App<typeof base.triggers, typeof creates>;
}
