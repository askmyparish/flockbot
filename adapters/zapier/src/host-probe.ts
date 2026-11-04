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
  InvocationStore,
  InvocationCoordinator,
  type HostBundle,
  type HostErrors,
} from "./authentication.js";
import { CONFIGURATION_VERSION } from "./policy.js";

export const HOST_PROBE_CONSENT = "authorize-read-only-host-probe";
export interface HostProbePlan {
  readonly subdomain: string;
  readonly networkId: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}
function invalid(): never {
  throw new FlockbotError("invalid_configuration");
}
function target(plan: HostProbePlan, bundle: HostBundle) {
  if (
    typeof plan.subdomain !== "string" ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(plan.subdomain) ||
    typeof plan.networkId !== "string" ||
    !/^[1-9][0-9]*$/.test(plan.networkId) ||
    !Number.isSafeInteger(plan.createdAt) ||
    !Number.isSafeInteger(plan.expiresAt) ||
    plan.createdAt > Date.now() ||
    plan.expiresAt <= Date.now() ||
    plan.expiresAt <= plan.createdAt ||
    plan.expiresAt - plan.createdAt > 30 * 60_000 ||
    bundle.authData.subdomain !== plan.subdomain
  )
    invalid();
  return `https://${plan.subdomain}.flocknote.com`;
}
function mapped(z: HostErrors, error: unknown): Error {
  const code = error instanceof FlockbotError ? error.code : "adapter_failed";
  return new z.errors.Error(
    `Read-only host probe stopped (${code}).`,
    code,
    400,
  );
}

/** Separate read-only artifact: never a production coordinator or write switch. */
export function createHostProbeApp(
  input: HostProbePlan,
  transport: Transport = fetchTransport,
) {
  const plan = Object.freeze({ ...input });
  const disabledAuth = async (z: HostErrors) => {
    throw new z.errors.Error(
      "Reuse the existing test connection; this probe cannot authenticate or refresh.",
      "probe_reuse_existing_connection",
      400,
    );
  };
  const auth = createAuthentication();
  const creates = {
    lock_hold: {
      key: "lock_hold",
      noun: "Lock Observation",
      display: {
        label: "Observe Native Connection Lock",
        description:
          "Harmless three-second hold for a controlled connection-lock test.",
      },
      operation: {
        lock: {
          key: "flockbot-host-probe",
          scope: ["auth" as const],
          timeout: 5,
        },
        perform: async (z: HostErrors, bundle: HostBundle) => {
          try {
            target(plan, bundle);
            if (
              bundle.inputData.consent !== HOST_PROBE_CONSENT ||
              typeof bundle.inputData.slot !== "string" ||
              !["A", "B"].includes(bundle.inputData.slot) ||
              Object.keys(bundle.inputData).some(
                (key) => !["consent", "slot"].includes(key),
              )
            )
              invalid();
            const slot = bundle.inputData.slot as "A" | "B";
            const startedAt = Date.now(),
              start = performance.now();
            await new Promise((resolve) => setTimeout(resolve, 3000));
            target(plan, bundle);
            return {
              slot,
              startedAt,
              finishedAt: Date.now(),
              heldMs: Math.round(performance.now() - start),
              lockGuaranteeProven: false,
            };
          } catch (error) {
            throw mapped(z, error);
          }
        },
        inputFields: [
          { key: "consent", required: true, choices: [HOST_PROBE_CONSENT] },
          { key: "slot", required: true, choices: ["A", "B"] },
        ],
        sample: {
          slot: "A",
          startedAt: 1000,
          finishedAt: 4000,
          heldMs: 3000,
          lockGuaranteeProven: false,
        },
      },
    },
    verify_saved_session: {
      key: "verify_saved_session",
      noun: "Saved Session Observation",
      display: {
        label: "Verify Existing Saved Session",
        description:
          "Read-only verification without password login or host refresh.",
      },
      operation: {
        perform: async (z: HostErrors, bundle: HostBundle) => {
          const controller = new AbortController();
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            const origin = target(plan, bundle);
            if (
              bundle.inputData.consent !== HOST_PROBE_CONSENT ||
              Object.keys(bundle.inputData).some((key) => key !== "consent")
            )
              invalid();
            const state = decode(bundle.authData.sessionData);
            if (!state || state.origin !== origin) invalid();
            const store = new InvocationStore(state);
            let requests = 0;
            timer = setTimeout(
              () => controller.abort(),
              Math.min(20_000, plan.expiresAt - Date.now()),
            );
            const bounded: Transport = async (request) => {
              const url = new URL(request.url);
              if (
                controller.signal.aborted ||
                Date.now() >= plan.expiresAt ||
                requests >= 2 ||
                request.method !== "GET" ||
                url.origin !== origin ||
                url.search ||
                url.hash ||
                !["/user/userData", "/network/getMetadata"].includes(
                  url.pathname,
                )
              )
                throw new RequestNotSentError();
              requests++;
              return transport(request);
            };
            const client = new FlockbotClient({
              subdomain: plan.subdomain,
              configurationVersion: CONFIGURATION_VERSION,
              sessionStore: store,
              coordinator: new InvocationCoordinator(),
              transport: bounded,
              policy: { timeoutMs: 20_000, maxReadRetries: 0 },
            });
            const options = { signal: controller.signal };
            await client.connect(options);
            const metadata = (await client.get(
              "network/getMetadata",
              options,
            )) as { networkID?: unknown };
            const id = metadata?.networkID;
            if (
              (typeof id !== "string" &&
                !(
                  typeof id === "number" &&
                  Number.isSafeInteger(id) &&
                  id > 0
                )) ||
              String(id) !== plan.networkId
            )
              invalid();
            return {
              connected: true,
              requests,
              rotationObserved: (await store.revision()) !== "0",
              passwordReads: 0,
              normalActionPersistenceProven: false,
            };
          } catch (error) {
            throw mapped(z, error);
          } finally {
            if (timer !== undefined) clearTimeout(timer);
            controller.abort();
          }
        },
        inputFields: [
          { key: "consent", required: true, choices: [HOST_PROBE_CONSENT] },
        ],
        sample: {
          connected: true,
          requests: 2,
          rotationObserved: false,
          passwordReads: 0,
          normalActionPersistenceProven: false,
        },
      },
    },
  };
  return {
    version: "2.0.2",
    platformVersion: version,
    flags: { skipHttpPatch: true },
    triggers: {},
    creates,
    authentication: {
      ...auth,
      test: disabledAuth,
      sessionConfig: { perform: disabledAuth },
    },
  } satisfies App<Record<string, never>, typeof creates>;
}
