import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Cookie, CookieJar } from "tough-cookie";
import {
  FlockbotClient,
  FlockbotError,
  type Credentials,
  type SessionState,
  type SessionStore,
  type Transport,
} from "../../../src/index.js";
import { safeFailureReason } from "../../../src/failure-reason.js";
import { Network } from "../../../src/models/network.js";
import {
  allowedEndpoint,
  AuthenticationSuspectedError,
  ConnectionError,
  type SessionFactory,
  type FlocknoteSession,
} from "./session.js";
import { recordResponse, responseError } from "./diagnostics.js";
import { SerialCoordinator } from "./serial-coordinator.js";
import {
  serveSignInPage,
  type SignInPageServer,
  type SignInResult,
} from "./sign-in-page.js";
import { MCP_VERSION } from "./version.js";

const MAX_BODY_BYTES = 1024 * 1024;
export const REQUEST_MS = 15_000;
const SESSION_COOKIE = /^(?:Flocknote|Flocknote-Login-\d+)$/;
/** Names this connector, its version and where to reach its maintainers. */
export const USER_AGENT = `AskMyParish-Flockbot/${MCP_VERSION} (+https://github.com/askmyparish/flockbot)`;

export interface HttpSessionDependencies {
  readonly fetch?: typeof fetch;
  /** Hands a local URL to the user's default browser. */
  readonly open?: (url: string) => Promise<void>;
  readonly serve?: typeof serveSignInPage;
  /** Where the session is kept; the profile folder's file by default. */
  readonly storage?: (profile: string) => SessionBlob;
  /** Shows another sign-in surface, such as the Mac app, instead of the page. */
  readonly openSignIn?: (parish: string) => Promise<void>;
}

interface Saved {
  readonly revision: number;
  readonly state: SessionState | null;
}

/** Where one connection's saved session text lives. */
export interface SessionBlob {
  get(): Promise<string | null>;
  set(text: string): Promise<void>;
}

/** Owner-only file in the connection's profile folder. */
export function sessionFile(directory: string): SessionBlob {
  const path = join(directory, "session.json");
  return {
    async get() {
      if (!existsSync(path)) return null;
      if (!lstatSync(path).isFile()) throw new Error();
      return readFileSync(path, "utf8");
    },
    async set(text) {
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temporary, text, { mode: 0o600, flag: "wx" });
        renameSync(temporary, path);
      } finally {
        rmSync(temporary, { force: true });
      }
    },
  };
}

/**
 * One parish connection's session cookies. The password never reaches it.
 * Revisions reject a stale writer, so two local assistants sharing the store
 * cannot overwrite a newer cookie.
 */
class SavedSession implements SessionStore {
  readonly #blob: SessionBlob;

  constructor(blob: SessionBlob) {
    this.#blob = blob;
  }

  async read(): Promise<Saved> {
    try {
      const text = await this.#blob.get();
      if (text === null) return { revision: 0, state: null };
      const value = JSON.parse(text) as {
        version?: unknown;
        revision?: unknown;
        state?: unknown;
      };
      if (
        value.version !== 1 ||
        typeof value.revision !== "number" ||
        !Number.isSafeInteger(value.revision) ||
        value.revision < 0 ||
        typeof value.state !== "object"
      )
        throw new Error();
      return {
        revision: value.revision,
        state: value.state as SessionState | null,
      };
    } catch {
      throw new ConnectionError("profile_unavailable");
    }
  }

  async write(
    state: SessionState | null,
    expectedRevision: string,
  ): Promise<void> {
    const current = await this.read();
    if (String(current.revision) !== expectedRevision)
      throw new FlockbotError("stale_session_state");
    await this.#blob.set(
      `${JSON.stringify({ version: 1, revision: current.revision + 1, state })}\n`,
    );
  }

  async load(): Promise<SessionState | null> {
    return (await this.read()).state;
  }
  async revision(): Promise<string> {
    return String((await this.read()).revision);
  }
  async save(state: SessionState, expectedRevision: string): Promise<void> {
    await this.write(state, expectedRevision);
  }
  async clear(expectedRevision: string): Promise<void> {
    await this.write(null, expectedRevision);
  }
}

// The shared client applies the same acceptance rule to every cookie it saves:
// only Flocknote's named session cookies, only for this parish or its parent.
function sessionCookie(value: string, host: string): Cookie | undefined {
  const cookie = Cookie.parse(value);
  if (
    !cookie ||
    !SESSION_COOKIE.test(cookie.key) ||
    (cookie.domain !== null &&
      cookie.domain !== host &&
      cookie.domain !== "flocknote.com")
  )
    return undefined;
  if (cookie.maxAge !== null) {
    cookie.expires = cookie.expiryDate(new Date()) ?? "Infinity";
    cookie.maxAge = null;
  }
  return cookie;
}

function serialized(jar: CookieJar): string[] {
  return (jar.serializeSync()?.cookies ?? []).flatMap((value) => {
    const cookie = Cookie.fromJSON(value);
    return cookie ? [cookie.toString()] : [];
  });
}

function openInDefaultBrowser(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (process.platform !== "darwin") {
      reject(new Error("Opening the sign-in page is supported on macOS only."));
      return;
    }
    execFile("/usr/bin/open", [url], { timeout: 10_000 }, (error) =>
      error ? reject(error) : resolve(),
    );
  });
}

interface Exchange {
  data?: unknown;
  error?: string;
  authentication?: boolean;
  reason?: string;
  status?: number;
  contentType?: string;
  bytes?: number;
}

/**
 * A Flocknote session over plain HTTPS, behind the same contract as the
 * browser-backed one. The saved cookie is this OS user's only credential:
 * sign-in happens on a loopback page that hands the typed password to the
 * shared client's login and keeps nothing but the resulting cookies. Requests
 * are limited to the same internal endpoints and classified the same way.
 */
export function httpSessionFactory(
  dependencies: HttpSessionDependencies = {},
): SessionFactory {
  const underlying = dependencies.fetch ?? fetch;
  // The one path to Flocknote: sign-in and every later request identify alike.
  const send: typeof fetch = (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("User-Agent", USER_AGENT);
    return underlying(input, { ...init, headers });
  };
  const open = dependencies.open ?? openInDefaultBrowser;
  const serve = dependencies.serve ?? serveSignInPage;
  return async (options) => {
    const host = new URL(options.origin).hostname;
    if (!host.endsWith(".flocknote.com"))
      throw new FlockbotError("invalid_configuration");
    const parish = host.slice(0, -".flocknote.com".length);
    if (new Network(parish).origin !== options.origin)
      throw new FlockbotError("invalid_configuration");
    const file = new SavedSession(
      (dependencies.storage ?? sessionFile)(options.profile),
    );
    const coordinator = new SerialCoordinator();
    const transport: Transport = async (request) => {
      const response = await send(request.url, {
        method: request.method,
        headers: request.headers,
        ...(request.body === undefined ? {} : { body: request.body }),
        redirect: "manual",
        signal: request.signal,
      });
      return {
        status: response.status,
        headers: response.headers,
        body: await response.text(),
      };
    };
    const passwordSignIn = async (
      credentials: Credentials,
    ): Promise<SignInResult> => {
      // A fresh generation per attempt: the client's block on repeating a
      // rejected stored password must not stop a person retyping theirs.
      const client = new FlockbotClient({
        subdomain: parish,
        sessionStore: file,
        coordinator,
        configurationVersion: randomUUID().replaceAll("-", ""),
        transport,
        credentialProvider: { load: async () => credentials },
      });
      try {
        await client.connect({ forcePasswordLogin: true });
        return "signed_in";
      } catch (error) {
        const code = error instanceof FlockbotError ? error.code : undefined;
        if (code === "credentials_rejected") return "credentials_rejected";
        if (code === "action_required") return "password_unavailable";
        if (
          code === "authentication_unavailable" ||
          code === "operation_timeout"
        )
          return "unavailable";
        return "failed";
      }
    };
    // One exchange at a time. Each reads the saved cookies, sends them and
    // saves any rotation against that revision, so two side by side would
    // start from the same cookies and the later save would drop the earlier
    // rotation.
    let exchanges: Promise<unknown> = Promise.resolve();
    const serially = <T>(work: () => Promise<T>): Promise<T> => {
      const run = exchanges.then(work);
      exchanges = run.catch(() => undefined);
      return run;
    };
    const exchange = async (
      path: string,
      method: "GET" | "POST",
      body: string | undefined,
      photo: Parameters<FlocknoteSession["request"]>[3],
    ): Promise<Exchange> => {
      const url = `${options.origin}/${path}`;
      const saved = await file.read();
      const jar = new CookieJar();
      for (const value of saved.state?.cookies ?? []) {
        const cookie = sessionCookie(value, host);
        if (cookie) jar.setCookieSync(cookie, options.origin);
      }
      // Without a saved session there is nothing to ask Flocknote.
      if (!jar.getCookiesSync(url).some((cookie) => cookie.key === "Flocknote"))
        throw new FlockbotError("authentication_required");
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_MS);
      const metadata: Pick<Exchange, "status" | "contentType" | "bytes"> = {};
      let response: Response | undefined;
      try {
        let multipart: FormData | undefined;
        if (photo) {
          const bytes = Buffer.from(photo.base64, "base64");
          multipart = new FormData();
          multipart.set("qquuid", randomUUID());
          multipart.set("qqfilename", photo.filename);
          multipart.set("qqtotalfilesize", String(bytes.length));
          multipart.set(
            "qqfile",
            new Blob([bytes], { type: photo.mime }),
            photo.filename,
          );
        }
        response = await send(url, {
          method,
          redirect: "manual",
          cache: "no-store",
          signal: controller.signal,
          headers: {
            Cookie: jar.getCookieStringSync(url),
            // A browser's same-origin POST names its origin; keep that shape.
            ...(method === "POST" ? { Origin: options.origin } : {}),
            ...(multipart || body === undefined
              ? {}
              : { "Content-Type": "application/x-www-form-urlencoded" }),
          },
          ...(multipart
            ? { body: multipart }
            : body === undefined
              ? {}
              : { body }),
        });
        if (response.status >= 100 && response.status <= 599)
          metadata.status = response.status;
        // A browser keeps whatever session cookies a response sets.
        let rotated = false;
        for (const value of response.headers.getSetCookie()) {
          const cookie = sessionCookie(value, host);
          if (!cookie) continue;
          try {
            jar.setCookieSync(cookie, url);
            rotated = true;
          } catch {
            /* A cookie the jar refuses is not kept. */
          }
        }
        const cookies = serialized(jar);
        if (
          rotated &&
          JSON.stringify(cookies) !== JSON.stringify(saved.state?.cookies ?? [])
        ) {
          try {
            await file.write(
              { version: 1, origin: options.origin, cookies },
              String(saved.revision),
            );
          } catch (error) {
            // Only a newer saved session may replace these cookies. Any other
            // failure lost them, and later requests would send stale ones.
            if (
              !(
                error instanceof FlockbotError &&
                error.code === "stale_session_state"
              )
            )
              throw new ConnectionError("profile_unavailable");
          }
        }
        const type = response.headers.get("Content-Type") ?? "";
        const json = /(?:^|\/)json(?:;|$)|\+json(?:;|$)/i.test(type);
        metadata.contentType = !type
          ? "missing"
          : json
            ? "json"
            : /^text\/html(?:;|$)/i.test(type)
              ? "html"
              : /^text\//i.test(type)
                ? "text"
                : "other";
        if (response.status >= 300 && response.status < 400)
          return {
            ...metadata,
            error: "redirect_rejected",
            authentication: true,
            reason: "redirect",
          };
        if (response.status === 401)
          return {
            ...metadata,
            error: "upstream_rejected",
            authentication: true,
            reason: "http_rejection",
          };
        if (response.status === 403)
          return {
            ...metadata,
            error: "permission_denied",
            authentication: true,
            reason: "http_rejection",
          };
        if (!response.ok)
          return {
            ...metadata,
            error: "upstream_rejected",
            reason: "http_rejection",
          };
        const reader = response.body?.getReader();
        if (!reader)
          return {
            ...metadata,
            error: "invalid_response",
            reason: "missing_response_body",
          };
        let size = 0;
        let text = "";
        const decoder = new TextDecoder();
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          metadata.bytes = size;
          if (size > MAX_BODY_BYTES) {
            controller.abort();
            return {
              ...metadata,
              error: "invalid_response",
              reason: "response_too_large",
            };
          }
          text += decoder.decode(chunk.value, { stream: true });
        }
        text += decoder.decode();
        metadata.bytes = size;
        response = undefined;
        if (json) {
          try {
            return { ...metadata, data: JSON.parse(text) as unknown };
          } catch {
            return {
              ...metadata,
              error: "invalid_response",
              reason: size === 0 ? "empty_response" : "invalid_json",
            };
          }
        }
        return {
          ...metadata,
          data: text,
          ...(size === 0 ? { reason: "empty_response" } : {}),
        };
      } catch (error) {
        if (error instanceof ConnectionError) throw error;
        return {
          ...metadata,
          error: controller.signal.aborted
            ? "operation_timeout"
            : "transport_failed",
          reason: controller.signal.aborted
            ? "request_timeout"
            : "fetch_failed",
        };
      } finally {
        clearTimeout(timer);
        // Release the connection when a rejected response's body goes unread.
        await response?.body?.cancel().catch(() => undefined);
      }
    };
    let page: SignInPageServer | undefined;
    const closePage = async () => {
      const current = page;
      page = undefined;
      await current?.close();
    };
    return {
      async request(path, method = "GET", body, photo) {
        if (
          photo
            ? path !== "upload/photo/note" ||
              method !== "POST" ||
              body !== undefined
            : !allowedEndpoint(path, method)
        )
          throw new FlockbotError("invalid_path");
        const { result, ms } = await serially(async () => {
          const started = performance.now();
          const result = await exchange(path, method, body, photo);
          return { result, ms: performance.now() - started };
        });
        const event = recordResponse(path, method, result, ms, body);
        const reason = safeFailureReason(result.reason);
        switch (result.error) {
          case undefined:
            return result.data;
          case "redirect_rejected":
          case "permission_denied":
          case "upstream_rejected":
            if (result.authentication)
              throw responseError(
                new AuthenticationSuspectedError(
                  result.error,
                  reason,
                  result.status,
                ),
                event,
              );
            throw responseError(
              new FlockbotError(
                result.error,
                result.status,
                undefined,
                undefined,
                reason,
              ),
              event,
            );
          case "invalid_response":
          case "operation_timeout":
          case "transport_failed":
            throw responseError(
              new FlockbotError(
                result.error,
                result.status,
                undefined,
                undefined,
                reason,
              ),
              event,
            );
          default:
            throw new FlockbotError("invalid_response");
        }
      },
      async signIn() {
        await closePage();
        try {
          if (dependencies.openSignIn) {
            await dependencies.openSignIn(parish);
            return;
          }
          page = await serve({ parish, signIn: passwordSignIn });
          await open(page.url);
        } catch {
          await closePage().catch(() => undefined);
          throw new ConnectionError(
            "browser_unavailable",
            undefined,
            "sign_in",
          );
        }
      },
      finishSignIn: closePage,
      close: closePage,
    };
  };
}
