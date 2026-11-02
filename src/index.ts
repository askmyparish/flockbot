import {
  Group,
  dashboardGroups,
  navigationGroups,
  subscriberCount,
} from "./groups.js";
export type {
  Group,
  GroupAttributes,
  SubscriberCountOptions,
} from "./groups.js";
import { Cookie, CookieJar } from "tough-cookie";
import {
  Operation,
  type OperationClock,
  type OperationPolicy,
  type OperationOptions,
} from "./operation.js";
export type {
  OperationClock,
  OperationPolicy,
  OperationOptions,
} from "./operation.js";

/** Secret-bearing state. Only adapters' protected session stores should persist it. */
export interface SessionState {
  readonly version: 1;
  readonly origin: string;
  readonly cookies: readonly string[];
  readonly intervention?: {
    readonly configurationVersion: string;
    readonly reason: "credentials_rejected" | "action_required";
  };
}

export interface SessionStore {
  load(): Promise<SessionState | null>;
  /** Monotonic opaque revision, never reused, even after clear. Read under coordination. */
  revision(): Promise<string>;
  /** Atomically compare revision, write, and advance revision. Reject stale writes. */
  save(state: SessionState, expectedRevision: string): Promise<void>;
  clear(expectedRevision: string): Promise<void>;
}

/** Adapters must serialize the identity across all invocations, including reset.
 * Do not release a running callback on cancellation; fence expired lease holders.
 */
export interface SessionCoordinator {
  runExclusive<T>(
    identity: string,
    signal: AbortSignal,
    work: () => Promise<T>,
  ): Promise<T>;
}

/** A transport may assert this only when no upstream request was submitted. */
export class RequestNotSentError extends Error {
  constructor() {
    super("Request was not submitted.");
    this.name = "RequestNotSentError";
  }
}

export interface Credentials {
  readonly email: string;
  readonly password: string;
}

/** Adapters obtain these values outside ordinary request and model interfaces. */
export interface CredentialProvider {
  load(): Promise<Credentials>;
}

export interface TransportRequest {
  readonly url: string;
  readonly method: "GET" | "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly redirect: "manual";
  readonly signal: AbortSignal;
}

export interface TransportResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly body: string;
}

/** Implementations must honor manual redirects and use only the supplied URL. */
export type Transport = (
  request: TransportRequest,
) => Promise<TransportResponse>;

export type ErrorCode =
  | "coordination_failed"
  | "operation_failed"
  | "stale_session_state"
  | "operation_timeout"
  | "operation_cancelled"
  | "request_not_sent"
  | "write_outcome_unknown"
  | "permission_denied"
  | "invalid_configuration"
  | "invalid_path"
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

export class FlockbotError extends Error {
  readonly code: ErrorCode;
  readonly status?: number;
  readonly outcome: "not_submitted" | "unknown" | undefined;

  constructor(
    code: ErrorCode,
    status?: number,
    outcome?: "not_submitted" | "unknown",
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
    if (status !== undefined) this.status = status;
  }
}

export interface ClientOptions {
  readonly subdomain: string;
  readonly sessionStore: SessionStore;
  readonly coordinator: SessionCoordinator;
  /** Nonsecret opaque generation; change when credential/configuration changes. */
  readonly configurationVersion?: string;
  readonly policy?: Partial<OperationPolicy>;
  readonly clock?: OperationClock;
  readonly transport?: Transport;
  readonly credentialProvider?: CredentialProvider;
}

export interface ConnectOptions extends OperationOptions {
  /** Explicitly start password setup even when a saved session exists. */
  readonly forcePasswordLogin?: boolean;
}

export const fetchTransport: Transport = async (request) => {
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    ...(request.body === undefined ? {} : { body: request.body }),
    redirect: "manual",
    credentials: "omit",
    signal: request.signal,
  });
  return {
    status: response.status,
    headers: response.headers,
    body: await response.text(),
  };
};

function parishOrigin(subdomain: string): string {
  if (
    typeof subdomain !== "string" ||
    subdomain.length > 63 ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(subdomain)
  ) {
    throw new FlockbotError("invalid_configuration");
  }
  return `https://${subdomain.toLowerCase()}.flocknote.com`;
}

function endpoint(origin: string, path: string): string {
  // Endpoints are paths, never URLs, queries, fragments, or encoded separators.
  if (
    typeof path !== "string" ||
    !/^\/?[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(path)
  ) {
    throw new FlockbotError("invalid_path");
  }
  return `${origin}/${path.replace(/^\//, "")}`;
}

function allowedCookie(value: string, origin: string): Cookie {
  const cookie = Cookie.parse(value);
  const host = new URL(origin).hostname;
  if (
    !cookie ||
    !/^(?:Flocknote|Flocknote-Login-\d+)$/.test(cookie.key) ||
    (cookie.domain !== null &&
      cookie.domain !== host &&
      cookie.domain !== "flocknote.com")
  ) {
    throw new FlockbotError("invalid_session_state");
  }
  // Fix Max-Age at capture time. Cookie retrieval updates lastAccessed, which
  // tough-cookie otherwise uses as the starting point of its relative expiry.
  if (cookie.maxAge !== null) {
    cookie.expires = cookie.expiryDate(new Date()) ?? "Infinity";
    cookie.maxAge = null;
  }
  return cookie;
}

function sessionState(
  origin: string,
  cookies: readonly string[],
): SessionState {
  const state: SessionState = { version: 1, origin, cookies };
  Object.defineProperty(state, Symbol.for("nodejs.util.inspect.custom"), {
    value: () => "SessionState { [REDACTED] }",
  });
  return state;
}

function cloneJar(jar: CookieJar): CookieJar {
  const copy = jar.cloneSync();
  if (!copy) throw new FlockbotError("invalid_session_state");
  return copy;
}

function serializedCookies(jar: CookieJar): string[] {
  const serialized = jar.serializeSync();
  if (!serialized) throw new Error();
  return serialized.cookies.map((cookie) => {
    const parsed = Cookie.fromJSON(cookie);
    if (!parsed) throw new Error();
    return parsed.toString();
  });
}

function authenticationRecord(value: unknown): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("success" in value) ||
    value.success !== true
  ) {
    throw new FlockbotError("authentication_protocol_error");
  }
  return value as Record<string, unknown>;
}

function authenticationError(error: unknown): FlockbotError {
  if (error instanceof FlockbotError) {
    if (
      error.code === "transport_failed" ||
      error.code === "request_not_sent" ||
      (error.code === "upstream_rejected" &&
        (error.status === 429 || (error.status ?? 0) >= 500))
    ) {
      return new FlockbotError("authentication_unavailable");
    }
    if (
      error.code !== "invalid_response" &&
      error.code !== "redirect_rejected" &&
      error.code !== "upstream_rejected"
    ) {
      return error;
    }
  }
  return new FlockbotError("authentication_protocol_error");
}

/** Capture an already-authenticated token without opening a browser or logging in. */
export function sessionFromToken(
  subdomain: string,
  token: string,
): SessionState {
  const origin = parishOrigin(subdomain);
  if (
    typeof token !== "string" ||
    !/^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]+$/.test(token)
  ) {
    throw new FlockbotError("invalid_session_state");
  }
  return sessionState(origin, [
    `Flocknote=${token}; Domain=flocknote.com; Path=/; Secure; HttpOnly`,
  ]);
}

interface Connection {
  jar: CookieJar;
  state: SessionState | null;
  revision: string;
}

export class FlockbotClient {
  readonly #origin: string;
  readonly #store: SessionStore;
  readonly #transport: Transport;
  readonly #credentials: CredentialProvider | undefined;
  readonly #coordinator: SessionCoordinator;
  readonly #configurationVersion: string;
  readonly #policy: Partial<OperationPolicy> | undefined;
  readonly #clock: OperationClock | undefined;
  #pending: { state: SessionState; baseRevision: string } | undefined;

  constructor(options: ClientOptions) {
    this.#origin = parishOrigin(options.subdomain);
    this.#store = options.sessionStore;
    this.#transport = options.transport ?? fetchTransport;
    this.#credentials = options.credentialProvider;
    this.#coordinator = options.coordinator;
    this.#configurationVersion = options.configurationVersion ?? "initial";
    if (
      typeof this.#configurationVersion !== "string" ||
      !/^[a-zA-Z0-9_-]{1,64}$/.test(this.#configurationVersion)
    ) {
      throw new FlockbotError("invalid_configuration");
    }
    this.#policy = options.policy;
    this.#clock = options.clock;
  }

  toJSON(): { type: string } {
    return { type: "FlockbotClient" };
  }
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return "FlockbotClient {}";
  }

  async #exclusive<T>(
    options: OperationOptions,
    work: (op: Operation) => Promise<T>,
  ): Promise<T> {
    const op = new Operation(this.#policy, this.#clock, options);
    return op.run(async () => {
      let callbackError: unknown;
      let callbackFailed = false;
      try {
        if (!this.#coordinator) throw new FlockbotError("coordination_failed");
        return await this.#coordinator.runExclusive(
          this.#origin,
          op.signal,
          async () => {
            try {
              op.check();
              return await work(op);
            } catch (error) {
              callbackFailed = true;
              callbackError = error;
              throw error;
            }
          },
        );
      } catch (error) {
        if (callbackFailed && error === callbackError) {
          if (error instanceof FlockbotError)
            throw new FlockbotError(error.code, error.status, error.outcome);
          throw new FlockbotError("operation_failed");
        }
        throw new FlockbotError("coordination_failed");
      }
    });
  }

  async #load(op: Operation): Promise<Connection> {
    let revision: string;
    let state: SessionState | null;
    try {
      revision = await this.#store.revision();
      op.check();
      state = await this.#store.load();
    } catch {
      op.check();
      throw new FlockbotError("session_load_failed");
    }
    op.check();
    if (typeof revision !== "string" || revision.length === 0)
      throw new FlockbotError("invalid_session_state");
    // Never retry an old rotation after a peer or reset advanced durable state.
    if (this.#pending && this.#pending.baseRevision !== revision)
      this.#pending = undefined;
    if (this.#pending) {
      await this.#save(this.#pending.state, revision, op);
      return this.#load(op);
    }
    const jar = new CookieJar();
    try {
      if (state !== null) {
        if (
          state.version !== 1 ||
          state.origin !== this.#origin ||
          !Array.isArray(state.cookies)
        )
          throw new Error();
        if (
          state.intervention &&
          (typeof state.intervention.configurationVersion !== "string" ||
            !["credentials_rejected", "action_required"].includes(
              state.intervention.reason,
            ))
        )
          throw new Error();
        for (const value of state.cookies) {
          if (typeof value !== "string") throw new Error();
          jar.setCookieSync(allowedCookie(value, this.#origin), this.#origin);
        }
      }
    } catch {
      throw new FlockbotError("invalid_session_state");
    }
    return { jar, state, revision };
  }

  async #save(
    state: SessionState,
    revision: string,
    op: Operation,
  ): Promise<void> {
    op.check();
    this.#pending = { state, baseRevision: revision };
    try {
      await this.#store.save(state, revision);
    } catch (error) {
      if (
        error instanceof FlockbotError &&
        error.code === "stale_session_state"
      ) {
        this.#pending = undefined;
        throw new FlockbotError("stale_session_state");
      }
      throw new FlockbotError("session_save_failed");
    }
    this.#pending = undefined;
    op.check();
  }

  #checkIntervention(connection: Connection): void {
    if (
      connection.state?.intervention?.configurationVersion ===
      this.#configurationVersion
    ) {
      throw new FlockbotError("action_required");
    }
  }

  async #persist(
    connection: Connection,
    op: Operation,
    force = false,
  ): Promise<void> {
    const state = sessionState(this.#origin, serializedCookies(connection.jar));
    if (
      force ||
      JSON.stringify(state.cookies) !==
        JSON.stringify(connection.state?.cookies ?? [])
    ) {
      await this.#save(state, connection.revision, op);
      connection.revision = await this.#revision(op);
      connection.state = state;
    }
  }

  async #revision(op: Operation): Promise<string> {
    try {
      const revision = await this.#store.revision();
      op.check();
      if (typeof revision !== "string" || !revision) throw new Error();
      return revision;
    } catch {
      op.check();
      throw new FlockbotError("session_load_failed");
    }
  }

  /** Verify saved authentication and recover once, under identity coordination. */
  connect(options: ConnectOptions = {}): Promise<void> {
    return this.#exclusive(options, async (op) => {
      const connection = await this.#load(op);
      this.#checkIntervention(connection);
      if (!options.forcePasswordLogin && this.#hasSession(connection)) {
        try {
          await this.#verify(connection, op);
          await this.#persist(connection, op);
          return;
        } catch (error) {
          if (
            !(error instanceof FlockbotError) ||
            error.code !== "authentication_required"
          )
            throw error;
        }
      }
      await this.#login(connection, op);
    });
  }

  #hasSession(connection: Connection): boolean {
    return connection.jar
      .getCookiesSync(endpoint(this.#origin, "user/userData"))
      .some((cookie) => cookie.key === "Flocknote");
  }

  async #verify(connection: Connection, op: Operation): Promise<void> {
    try {
      // Stage cookies: unknown, denied and invalid responses cannot rotate state.
      const candidate: Connection = {
        ...connection,
        jar: cloneJar(connection.jar),
      };
      // #request owns userData response classification for every caller.
      await this.#request(candidate, op, "GET", "user/userData");
      if (!this.#hasSession(candidate)) {
        throw new FlockbotError("authentication_protocol_error");
      }
      connection.jar = candidate.jar;
    } catch (error) {
      throw authenticationError(error);
    }
  }

  async #login(connection: Connection, op: Operation): Promise<void> {
    let credentials: Credentials;
    try {
      if (!this.#credentials) throw new Error();
      credentials = await this.#credentials.load();
      op.check();
      if (
        typeof credentials?.email !== "string" ||
        credentials.email.trim().length === 0 ||
        typeof credentials.password !== "string" ||
        credentials.password.length === 0
      )
        throw new Error();
    } catch {
      op.check();
      throw new FlockbotError("credentials_unavailable");
    }
    const candidate: Connection = {
      jar: new CookieJar(),
      state: null,
      revision: connection.revision,
    };
    try {
      const first = authenticationRecord(
        await this.#request(
          candidate,
          op,
          "POST",
          "login/twoFactorAuth",
          new URLSearchParams({
            firstFactor: credentials.email.trim(),
            initialLoad: "false",
            requestAuthCode: "false",
          }).toString(),
        ),
      );
      if (first.allowPasswordForFirstFactor === false)
        throw new FlockbotError("action_required");
      if (
        first.allowPasswordForFirstFactor !== true ||
        first.firstFactorSuccess !== false
      )
        throw new FlockbotError("authentication_protocol_error");
      const password = authenticationRecord(
        await this.#request(
          candidate,
          op,
          "POST",
          "login/twoFactorAuth",
          new URLSearchParams({
            firstFactor: credentials.email.trim(),
            initialLoad: "false",
            password: credentials.password,
          }).toString(),
        ),
      );
      if (password.allowPasswordForFirstFactor === false)
        throw new FlockbotError("action_required");
      if (password.loginSuccess !== true) {
        if (
          password.allowPasswordForFirstFactor === true &&
          password.firstFactorSuccess === false &&
          typeof password.message === "string" &&
          password.message.startsWith(
            "Sorry, that password doesn't match our records.",
          )
        )
          throw new FlockbotError("credentials_rejected");
        throw new FlockbotError("authentication_protocol_error");
      }
      await this.#verify(candidate, op);
    } catch (error) {
      const safe = authenticationError(error);
      if (
        safe.code === "credentials_rejected" ||
        safe.code === "action_required"
      ) {
        const blocked = sessionState(
          this.#origin,
          connection.state?.cookies ?? [],
        );
        Object.assign(blocked, {
          intervention: {
            configurationVersion: this.#configurationVersion,
            reason: safe.code,
          },
        });
        await this.#save(blocked, connection.revision, op);
      }
      throw safe;
    }
    connection.jar = candidate.jar;
    await this.#persist(connection, op, true);
  }

  /** Adapter operator interfaces authorize this reset; ordinary request callers must not expose it. */
  clearSession(options: OperationOptions = {}): Promise<void> {
    return this.#exclusive(options, async (op) => {
      const revision = await this.#revision(op);
      this.#pending = undefined;
      op.check();
      try {
        await this.#store.clear(revision);
      } catch (error) {
        if (
          error instanceof FlockbotError &&
          error.code === "stale_session_state"
        )
          throw error;
        throw new FlockbotError("session_clear_failed");
      }
      op.check();
    });
  }

  async get(path: string, options: OperationOptions = {}): Promise<unknown> {
    endpoint(this.#origin, path);
    return this.#readOperation(options, (read) => read(path));
  }

  /** Verify/recover once, then discover groups within one coordinated operation. */
  groups(options: OperationOptions = {}): Promise<readonly Group[]> {
    return this.#readOperation(options, async (read, verify) => {
      await verify();
      let attributes = dashboardGroups(await read("dashboard"));
      if (attributes === null) {
        const navigation = await read("navigation/groups");
        attributes = navigationGroups(
          navigation,
          await read("network/getMetadata"),
        );
      }
      return attributes.map(
        (attributes) =>
          new Group(attributes, (options) =>
            this.#readOperation(options, async (read, verify) => {
              await verify();
              return subscriberCount(
                await read(`group/${attributes.id}/getSubscriberCount`),
              );
            }),
          ),
      );
    });
  }

  /** Undefined only after successful discovery without an Everyone group. */
  async everyoneGroup(
    options: OperationOptions = {},
  ): Promise<Group | undefined> {
    return (await this.groups(options)).find((group) => group.isEveryone);
  }

  async #readOperation<T>(
    options: OperationOptions,
    work: (
      read: (path: string) => Promise<unknown>,
      verify: () => Promise<void>,
    ) => Promise<T>,
  ): Promise<T> {
    return this.#exclusive(options, async (op) => {
      const connection = await this.#load(op);
      this.#checkIntervention(connection);
      let recovered = false;
      if (!this.#hasSession(connection)) {
        await this.#login(connection, op);
        recovered = true;
      }
      const recover = async <R>(request: () => Promise<R>): Promise<R> => {
        for (;;) {
          try {
            return await request();
          } catch (error) {
            if (
              !recovered &&
              error instanceof FlockbotError &&
              error.code === "authentication_required"
            ) {
              recovered = true;
              await this.#login(connection, op);
              continue;
            }
            throw error;
          }
        }
      };
      const read = async (path: string): Promise<unknown> => {
        try {
          return await recover(() =>
            this.#request(connection, op, "GET", path),
          );
        } catch (error) {
          if (
            error instanceof FlockbotError &&
            error.code === "redirect_rejected"
          )
            await this.#persist(connection, op);
          throw error;
        }
      };
      const verify = async (): Promise<void> => {
        await recover(() => this.#verify(connection, op));
        // A later domain read must not discard an already-verified rotation.
        await this.#persist(connection, op);
      };
      const result = await work(read, verify);
      await this.#persist(connection, op);
      return result;
    });
  }

  post(
    path: string,
    fields: Readonly<Record<string, string>>,
    options: OperationOptions = {},
  ): Promise<unknown> {
    return this.#postOperation(
      path,
      new URLSearchParams(fields).toString(),
      options,
    );
  }

  async #postOperation(
    path: string,
    body: string,
    options: OperationOptions,
  ): Promise<unknown> {
    let submittedWrite = false;
    try {
      endpoint(this.#origin, path);
      return await this.#exclusive(options, async (op) => {
        const connection = await this.#load(op);
        this.#checkIntervention(connection);
        if (!this.#hasSession(connection)) await this.#login(connection, op);
        try {
          const data = await this.#request(
            connection,
            op,
            "POST",
            path,
            body,
            () => {
              submittedWrite = true;
            },
          );
          await this.#persist(connection, op);
          return data;
        } catch (error) {
          if (
            error instanceof FlockbotError &&
            error.code === "redirect_rejected"
          )
            await this.#persist(connection, op);
          throw error;
        }
      });
    } catch (error) {
      if (
        submittedWrite &&
        !(error instanceof FlockbotError && error.code === "request_not_sent")
      ) {
        if (error instanceof FlockbotError && error.code !== "operation_failed")
          throw new FlockbotError(error.code, error.status, "unknown");
        throw new FlockbotError("write_outcome_unknown");
      }
      if (error instanceof FlockbotError)
        throw new FlockbotError(error.code, error.status, "not_submitted");
      throw error;
    }
  }

  async #request(
    connection: Connection,
    op: Operation,
    method: "GET" | "POST",
    path: string,
    body?: string,
    onSubmit?: () => void,
  ): Promise<unknown> {
    const url = endpoint(this.#origin, path);
    let response: TransportResponse;
    for (;;) {
      op.check();
      const cookie = connection.jar.getCookieStringSync(url);
      try {
        onSubmit?.();
        response = await this.#transport({
          url,
          method,
          headers: {
            ...(cookie ? { Cookie: cookie } : {}),
            ...(body === undefined
              ? {}
              : { "Content-Type": "application/x-www-form-urlencoded" }),
          },
          ...(body === undefined ? {} : { body }),
          redirect: "manual",
          signal: op.signal,
        });
        op.check();
      } catch (error) {
        op.check();
        if (error instanceof RequestNotSentError)
          throw new FlockbotError("request_not_sent");
        if (method === "GET" && (await op.retry())) continue;
        throw new FlockbotError("transport_failed");
      }
      if (
        method === "GET" &&
        (response.status === 429 || response.status >= 500) &&
        (await op.retry())
      )
        continue;
      break;
    }
    if (
      !Number.isInteger(response.status) ||
      response.status < 200 ||
      response.status > 599
    )
      throw new FlockbotError("invalid_response");
    if (response.status >= 300 && response.status < 400) {
      this.#capture(connection, response, url);
      throw new FlockbotError("redirect_rejected");
    }
    if (response.status === 403)
      throw new FlockbotError("permission_denied", 403);
    if (response.status >= 400)
      throw new FlockbotError("upstream_rejected", response.status);
    let data: unknown;
    try {
      data = /(?:^|\/)json(?:;|$)|\+json(?:;|$)/i.test(
        response.headers.get("Content-Type") ?? "",
      )
        ? (JSON.parse(response.body) as unknown)
        : response.body;
    } catch {
      throw new FlockbotError("invalid_response");
    }
    if (path.replace(/^\//, "") === "user/userData") {
      const record = authenticationRecord(data);
      if (record.authorized === false && record.userID === null)
        throw new FlockbotError("authentication_required");
      if (
        record.authorized === false &&
        typeof record.userID === "number" &&
        record.userID > 0
      )
        throw new FlockbotError("permission_denied");
      if (
        record.authorized === false ||
        typeof record.userID !== "number" ||
        !Number.isSafeInteger(record.userID) ||
        record.userID <= 0
      )
        throw new FlockbotError("authentication_protocol_error");
    }
    if (
      typeof data === "object" &&
      data !== null &&
      (("success" in data && data.success === false) ||
        ("authorized" in data && data.authorized === false))
    ) {
      throw new FlockbotError("upstream_rejected", response.status);
    }
    this.#capture(connection, response, url);
    return data;
  }

  #capture(
    connection: Connection,
    response: TransportResponse,
    url: string,
  ): void {
    try {
      const candidate = cloneJar(connection.jar);
      for (const value of response.headers.getSetCookie()) {
        const parsed = Cookie.parse(value);
        if (!parsed || !/^(?:Flocknote|Flocknote-Login-\d+)$/.test(parsed.key))
          continue;
        candidate.setCookieSync(allowedCookie(value, this.#origin), url);
      }
      connection.jar = candidate;
    } catch {
      throw new FlockbotError("invalid_response");
    }
  }
}
