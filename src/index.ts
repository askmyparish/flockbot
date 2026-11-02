import { Cookie, CookieJar } from "tough-cookie";

/** Secret-bearing state. Only adapters' protected session stores should persist it. */
export interface SessionState {
  readonly version: 1;
  readonly origin: string;
  readonly cookies: readonly string[];
}

export interface SessionStore {
  load(): Promise<SessionState | null>;
  save(state: SessionState): Promise<void>;
  clear(): Promise<void>;
}

export interface Credentials {
  readonly email: string;
  readonly password: string;
}

/** Reserved for the shared password-login implementation; not read by this slice. */
export interface CredentialProvider {
  load(): Promise<Credentials>;
}

export interface TransportRequest {
  readonly url: string;
  readonly method: "GET" | "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly redirect: "manual";
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
  | "invalid_configuration"
  | "invalid_path"
  | "session_load_failed"
  | "invalid_session_state"
  | "session_save_failed"
  | "session_clear_failed"
  | "transport_failed"
  | "redirect_rejected"
  | "invalid_response"
  | "upstream_rejected";

export class FlockbotError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode) {
    super(`Flockbot request failed (${code}).`);
    this.name = "FlockbotError";
    this.code = code;
  }
}

export interface ClientOptions {
  readonly subdomain: string;
  readonly sessionStore: SessionStore;
  readonly transport?: Transport;
  readonly credentialProvider?: CredentialProvider;
}

export const fetchTransport: Transport = async (request) => {
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    ...(request.body === undefined ? {} : { body: request.body }),
    redirect: "manual",
    credentials: "omit",
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

function serializedCookies(jar: CookieJar): string[] {
  const serialized = jar.serializeSync();
  if (!serialized) throw new Error();
  return serialized.cookies.map((cookie) => {
    const parsed = Cookie.fromJSON(cookie);
    if (!parsed) throw new Error();
    return parsed.toString();
  });
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

export class FlockbotClient {
  readonly #origin: string;
  readonly #store: SessionStore;
  readonly #transport: Transport;
  #jar: CookieJar | undefined;
  #pendingState: SessionState | undefined;

  constructor(options: ClientOptions) {
    this.#origin = parishOrigin(options.subdomain);
    this.#store = options.sessionStore;
    this.#transport = options.transport ?? fetchTransport;
  }

  toJSON(): { type: string } {
    return { type: "FlockbotClient" };
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return "FlockbotClient {}";
  }

  async clearSession(): Promise<void> {
    this.#jar = undefined;
    this.#pendingState = undefined;
    try {
      await this.#store.clear();
    } catch {
      throw new FlockbotError("session_clear_failed");
    }
  }

  get(path: string): Promise<unknown> {
    return this.#request("GET", path);
  }

  post(
    path: string,
    fields: Readonly<Record<string, string>>,
  ): Promise<unknown> {
    return this.#request("POST", path, new URLSearchParams(fields).toString());
  }

  async #loadJar(): Promise<CookieJar> {
    if (this.#jar) return this.#jar;
    let state: SessionState | null;
    try {
      state = await this.#store.load();
    } catch {
      throw new FlockbotError("session_load_failed");
    }
    const jar = new CookieJar();
    try {
      if (state !== null) {
        if (
          state.version !== 1 ||
          state.origin !== this.#origin ||
          !Array.isArray(state.cookies)
        ) {
          throw new Error();
        }
        for (const value of state.cookies) {
          if (typeof value !== "string") throw new Error();
          jar.setCookieSync(allowedCookie(value, this.#origin), this.#origin);
        }
      }
    } catch {
      throw new FlockbotError("invalid_session_state");
    }
    this.#jar = jar;
    return jar;
  }

  async #flushPendingState(): Promise<void> {
    if (!this.#pendingState) return;
    try {
      await this.#store.save(this.#pendingState);
      this.#pendingState = undefined;
    } catch {
      // Retain the replacement token. A later call retries this save before
      // sending another upstream request, without replaying the original call.
      throw new FlockbotError("session_save_failed");
    }
  }

  async #request(
    method: "GET" | "POST",
    path: string,
    body?: string,
  ): Promise<unknown> {
    const url = endpoint(this.#origin, path);
    const jar = await this.#loadJar();
    await this.#flushPendingState();
    const cookie = jar.getCookieStringSync(url);
    let response: TransportResponse;
    try {
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
      });
    } catch {
      throw new FlockbotError("transport_failed");
    }
    if (
      !Number.isInteger(response.status) ||
      response.status < 200 ||
      response.status > 599
    ) {
      throw new FlockbotError("invalid_response");
    }
    try {
      // Stage the entire response batch so one invalid auth cookie cannot
      // leave a partially mutated in-memory jar or partially persisted state.
      const serialized = jar.serializeSync();
      if (!serialized) throw new Error();
      const candidate = CookieJar.deserializeSync(serialized);
      for (const value of response.headers.getSetCookie()) {
        // Non-authentication cookies are unnecessary integration state.
        const parsed = Cookie.parse(value);
        if (!parsed || !/^(?:Flocknote|Flocknote-Login-\d+)$/.test(parsed.key))
          continue;
        candidate.setCookieSync(allowedCookie(value, this.#origin), url);
      }
      const before = serializedCookies(jar);
      const after = serializedCookies(candidate);
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        this.#jar = candidate;
        this.#pendingState = sessionState(this.#origin, after);
      }
    } catch {
      throw new FlockbotError("invalid_response");
    }
    await this.#flushPendingState();
    if (response.status >= 300 && response.status < 400) {
      throw new FlockbotError("redirect_rejected");
    }
    if (response.status >= 400) {
      throw new FlockbotError("upstream_rejected");
    }
    try {
      return /(?:^|\/)json(?:;|$)|\+json(?:;|$)/i.test(
        response.headers.get("Content-Type") ?? "",
      )
        ? (JSON.parse(response.body) as unknown)
        : response.body;
    } catch {
      throw new FlockbotError("invalid_response");
    }
  }
}
