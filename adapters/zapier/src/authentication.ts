import type { Bundle, ZObject } from "zapier-platform-core";
import {
  FlockbotClient,
  FlockbotError,
  type SessionCoordinator,
  type SessionState,
  type SessionStore,
  type Transport,
  type OperationOptions,
  type GroupAttributes,
} from "../../../src/index.js";
import { CLIENT_POLICY, CONFIGURATION_VERSION } from "./policy.js";

export type HostBundle = Pick<Bundle, "authData" | "inputData">;
export type HostErrors = Pick<ZObject, "errors">;

/** Injection seams for offline host models, not Zapier persistence APIs. */
export interface AdapterTestDependencies {
  readonly transport?: Transport;
  readonly sessionStore?: SessionStore;
  readonly coordinator?: SessionCoordinator;
}

export const feasibility = Object.freeze({
  operationalWritesReady: false,
  normalActionPersistence: "unverified",
  crossInvocationCoordination: "unverified",
});

function invalid(): never {
  throw new FlockbotError("invalid_configuration");
}

function configuration(bundle: HostBundle, setup: boolean) {
  const values = setup
    ? { ...bundle.authData, ...bundle.inputData }
    : bundle.authData;
  const subdomain = values.subdomain;
  const email = values.email;
  const password = values.password;
  const configurationVersion = CONFIGURATION_VERSION;
  if (typeof subdomain !== "string") invalid();
  if (
    setup &&
    (typeof email !== "string" ||
      !email ||
      typeof password !== "string" ||
      !password)
  )
    invalid();
  return { subdomain, email, password, configurationVersion };
}

function decode(value: unknown): SessionState | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") invalid();
  let parsed: { version?: unknown; state?: unknown };
  try {
    parsed = JSON.parse(value) as typeof parsed;
  } catch {
    return invalid();
  }
  if (
    parsed?.version !== 1 ||
    typeof parsed.state !== "object" ||
    !parsed.state
  )
    invalid();
  // The shared client validates origin, cookies and intervention on load.
  return parsed.state as SessionState;
}

/** A local generation exists only for this invocation. It is never durable CAS. */
class InvocationStore implements SessionStore {
  #state: SessionState | null;
  #revision = 0;
  constructor(state: SessionState | null) {
    this.#state = state;
  }
  async revision() {
    return String(this.#revision);
  }
  async load() {
    return this.#state;
  }
  async save(state: SessionState, expected: string) {
    if (expected !== String(this.#revision))
      throw new FlockbotError("stale_session_state");
    this.#state = state;
    this.#revision++;
  }
  async clear(expected: string) {
    if (expected !== String(this.#revision))
      throw new FlockbotError("stale_session_state");
    this.#state = null;
    this.#revision++;
  }
}

/** Serializes this one execution, never other Zapier invocations. */
class InvocationCoordinator implements SessionCoordinator {
  #tail: Promise<unknown> = Promise.resolve();
  async runExclusive<T>(
    _identity: string,
    signal: AbortSignal,
    work: () => Promise<T>,
  ): Promise<T> {
    const previous = this.#tail;
    let release = () => {};
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      if (signal.aborted) throw new FlockbotError("operation_cancelled");
      return await work();
    } finally {
      release();
    }
  }
}

export function mappedError(
  z: HostErrors,
  error: unknown,
  refreshRequested = false,
): Error {
  if (error instanceof FlockbotError) {
    if (refreshRequested && error.code === "credentials_unavailable")
      return new z.errors.RefreshAuthError(
        "The saved Flocknote session is no longer accepted.",
      );
    if (["credentials_rejected", "action_required"].includes(error.code))
      return new z.errors.ExpiredAuthError(
        "Reconnect the Flocknote connection after resolving authentication.",
      );
    return new z.errors.Error(
      `Flockbot connection failed (${error.code}).`,
      error.code,
      error.status ?? 400,
    );
  }
  return new z.errors.Error(
    "Flockbot connection failed (adapter_failed).",
    "adapter_failed",
    500,
  );
}

function protectedAuthentication(state: SessionState): { sessionData: string } {
  const allowed: SessionState = {
    version: 1,
    origin: state.origin,
    cookies: [...state.cookies],
    ...(state.intervention
      ? {
          intervention: {
            configurationVersion: state.intervention.configurationVersion,
            reason: state.intervention.reason,
          },
        }
      : {}),
  };
  const result = {
    sessionData: JSON.stringify({ version: 1, state: allowed }),
  };
  Object.defineProperty(result, Symbol.for("nodejs.util.inspect.custom"), {
    value: () => "Flockbot authentication { [REDACTED] }",
  });
  return result;
}

/** One read-only invocation owns one client/jar. No authData mutation is persisted. */
class ReadExecution {
  readonly #client: FlockbotClient;
  readonly #z: HostErrors;
  #refreshRequested = false;

  constructor(
    z: HostErrors,
    bundle: HostBundle,
    dependencies: AdapterTestDependencies = {},
  ) {
    this.#z = z;
    const config = configuration(bundle, false);
    this.#client = new FlockbotClient({
      subdomain: config.subdomain,
      configurationVersion: config.configurationVersion,
      sessionStore:
        dependencies.sessionStore ??
        new InvocationStore(decode(bundle.authData.sessionData)),
      coordinator: dependencies.coordinator ?? new InvocationCoordinator(),
      ...(dependencies.transport ? { transport: dependencies.transport } : {}),
      policy: CLIENT_POLICY,
      credentialProvider: {
        load: async () => {
          // Only the shared lifecycle requests credentials after an absent or
          // confirmed-invalid session. Defer safe read renewal to Session Auth.
          this.#refreshRequested = true;
          throw new Error("Renewal belongs to the authentication hook.");
        },
      },
    });
  }

  async verify(options: OperationOptions = {}): Promise<{ connected: true }> {
    try {
      await this.#client.connect(options);
      return { connected: true };
    } catch (error) {
      throw mappedError(this.#z, error, this.#refreshRequested);
    }
  }

  async read(path: string, options: OperationOptions = {}): Promise<unknown> {
    try {
      return await this.#client.get(path, options);
    } catch (error) {
      throw mappedError(this.#z, error, this.#refreshRequested);
    }
  }

  async groups(options: OperationOptions = {}): Promise<GroupAttributes[]> {
    try {
      return (await this.#client.groups(options)).map(
        ({ id, name, shortName, isEveryone }) => ({
          id,
          name,
          shortName,
          isEveryone,
        }),
      );
    } catch (error) {
      throw mappedError(this.#z, error, this.#refreshRequested);
    }
  }

  toJSON() {
    return { type: "FlockbotReadExecution" };
  }
  [Symbol.for("nodejs.util.inspect.custom")]() {
    return "FlockbotReadExecution {}";
  }
}

export function createReadExecution(
  z: HostErrors,
  bundle: HostBundle,
  dependencies: AdapterTestDependencies = {},
): ReadExecution {
  try {
    return new ReadExecution(z, bundle, dependencies);
  } catch (error) {
    throw mappedError(z, error);
  }
}

/** Fail before any operation callback until real host guarantees are established. */
export async function runOperationalWrite(
  z: HostErrors,
  _work: () => Promise<unknown>,
): Promise<never> {
  throw new z.errors.Error(
    "Flockbot writes are disabled until durable session persistence and coordination are verified.",
    "feasibility_blocked",
    409,
  );
}

export function createAuthentication(
  dependencies: AdapterTestDependencies = {},
) {
  return {
    type: "session" as const,
    fields: [
      {
        key: "subdomain",
        label: "Parish subdomain",
        type: "string" as const,
        required: true,
        isNoSecret: false,
      },
      {
        key: "email",
        label: "Flocknote login email",
        type: "string" as const,
        required: true,
        isNoSecret: false,
      },
      {
        key: "password",
        label: "Flocknote password",
        type: "password" as const,
        required: true,
        isNoSecret: false,
      },
      {
        key: "sessionData",
        type: "password" as const,
        computed: true,
        required: false,
        isNoSecret: false,
      },
    ],
    connectionLabel: "Flocknote connection",
    sessionConfig: {
      perform: async (z: HostErrors, bundle: HostBundle) => {
        try {
          const config = configuration(bundle, true);
          const store = dependencies.sessionStore ?? new InvocationStore(null);
          const client = new FlockbotClient({
            subdomain: config.subdomain,
            configurationVersion: config.configurationVersion,
            sessionStore: store,
            coordinator:
              dependencies.coordinator ?? new InvocationCoordinator(),
            ...(dependencies.transport
              ? { transport: dependencies.transport }
              : {}),
            policy: CLIENT_POLICY,
            credentialProvider: {
              load: async () => ({
                email: config.email as string,
                password: config.password as string,
              }),
            },
          });
          await client.connect({ forcePasswordLogin: true });
          const state = await store.load();
          if (!state) throw new FlockbotError("session_load_failed");
          return protectedAuthentication(state);
        } catch (error) {
          throw mappedError(z, error);
        }
      },
    },
    test: async (z: HostErrors, bundle: HostBundle) => {
      try {
        return await createReadExecution(z, bundle, dependencies).verify();
      } catch (error) {
        // Execution already maps errors; sanitize constructor failures only.
        if (error instanceof FlockbotError) throw mappedError(z, error);
        if (
          error instanceof Error &&
          ["RefreshAuthError", "ExpiredAuthError", "AppError"].includes(
            error.name,
          )
        )
          throw error;
        throw mappedError(z, error);
      }
    },
  };
}
