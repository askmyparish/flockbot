import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  FlockbotError,
  type MemberInput,
  type OperationOptions,
  type SessionCoordinator,
} from "../../../src/index.js";
import { Group } from "../../../src/models/group.js";
import { identifier } from "../../../src/models/identifier.js";
import {
  Network,
  normalizedGroupName,
  normalizeSubdomain,
} from "../../../src/models/network.js";
import { GroupMembership } from "../../../src/models/group-membership.js";
import { User } from "../../../src/models/user.js";
import { MemberProfile } from "../../../src/models/member-profile.js";
import {
  MemberCommunicationStatus,
  type MemberCommunicationInput,
} from "../../../src/models/member-communication-status.js";
import {
  MemberLatestEmailStatus,
  type MemberLatestEmailInput,
} from "../../../src/models/member-latest-email-status.js";
import {
  EmailAnalytics,
  type EmailAnalyticsInput,
} from "../../../src/models/email-analytics.js";
import {
  EmailRecipients,
  type EmailRecipientsInput,
} from "../../../src/models/email-recipients.js";
import { GroupNotes } from "../../../src/models/group-notes.js";
import { Note, type NoteInput } from "../../../src/models/note.js";
import {
  EmailDuplication,
  type EmailDuplicationInput,
} from "../../../src/models/email-duplication.js";
import {
  EmailDraft,
  type EmailDraftInput,
} from "../../../src/models/email-draft.js";
import {
  NoteSearch,
  type NoteSearchInput,
} from "../../../src/models/note-search.js";
import {
  MemberGroups,
  membershipGroupSelector,
  type GroupSelector,
} from "../../../src/models/member-groups.js";
import type { MemberField } from "../../../src/models/member-fields.js";
import {
  GroupMembers,
  type GroupMembersInput,
} from "../../../src/models/group-members.js";
import {
  MemberSearch,
  type MemberSearchInput,
} from "../../../src/models/member-search.js";
import {
  MemberFilters,
  type MemberFiltersInput,
} from "../../../src/models/member-filters.js";
import { FlocknoteLogin } from "../../../src/models/flocknote-login.js";
import { Operation } from "../../../src/operation.js";
import { DraftImages, type DraftImage } from "./draft-images.js";
import {
  AuthenticationSuspectedError,
  ConnectionError,
  type SessionFactory,
  type FlocknoteSession,
} from "./session.js";
import { ProcessLockTimeoutError } from "./process-lock.js";
import { QueueWaitTimeoutError } from "./serial-coordinator.js";
import { connectionProfileDirectory } from "./profile.js";
import {
  captureFailure,
  beginAuthDiagnosis,
  endAuthDiagnosis,
  validationSource,
  validationError,
} from "./diagnostics.js";

const SETUP_ERRORS = [
  "permission_denied",
  "browser_unavailable",
  "authentication_protocol_error",
  "operation_timeout",
  "operation_cancelled",
  "transport_failed",
  "upstream_rejected",
  "redirect_rejected",
  "invalid_response",
  "connection_changed",
] as const;
type SetupError = (typeof SETUP_ERRORS)[number];
const SETUP_STAGES = ["launch", "request_context", "sign_in", "close"] as const;
type SetupStage = (typeof SETUP_STAGES)[number];
function setupFailure(error: unknown): SetupError {
  if (
    (error instanceof FlockbotError || error instanceof ConnectionError) &&
    SETUP_ERRORS.some((code) => code === error.code)
  )
    return error.code as SetupError;
  return "browser_unavailable";
}

function requiresSignIn(error: unknown): boolean {
  return (
    (error instanceof FlockbotError &&
      error.code === "authentication_required") ||
    (error instanceof ConnectionError && error.code === "connection_changed")
  );
}

interface Connection {
  readonly version: 1;
  readonly generation: string;
  readonly parish: string;
  readonly userId: string | null;
  readonly state: "pending" | "ready" | "action_required";
  readonly setupError?: SetupError;
  readonly setupStage?: SetupStage;
  /** Process running a pending setup. Connectors share one profile, so another
   * process's coordinator can't tell a live setup from an abandoned one. */
  readonly owner?: number;
}

/** Where `inParish` collects the parish its operations ran against. */
const operationParish = new AsyncLocalStorage<{ parish?: string }>();

/** Whether another live process owns this pending setup. */
function ownedElsewhere(owner: number | undefined): boolean {
  if (owner === undefined || owner === process.pid) return false;
  try {
    process.kill(owner, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface ConnectionStatus {
  readonly state: "not_configured" | "pending" | "ready" | "action_required";
  readonly parish?: string;
  readonly setupError?: SetupError;
  readonly setupStage?: SetupStage;
}

function accepted(
  data: unknown,
  allowHtml = false,
  entryCheck = false,
): unknown {
  if (
    (typeof data === "object" &&
      data !== null &&
      "authorized" in data &&
      data.authorized === false) ||
    (!allowHtml && typeof data === "string" && data.trimStart().startsWith("<"))
  )
    throw new AuthenticationSuspectedError(
      typeof data === "string" ? "invalid_response" : "upstream_rejected",
      typeof data === "string" ? "unexpected_html" : "authorization_false",
    );
  if (
    typeof data === "object" &&
    data !== null &&
    "success" in data &&
    data.success === false &&
    !entryCheck
  )
    throw new FlockbotError(
      "upstream_rejected",
      undefined,
      undefined,
      undefined,
      "success_false",
    );
  return data;
}

export function prepareProfile(profile: string): void {
  try {
    for (const directory of [profile, join(profile, "browser")]) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const info = lstatSync(directory);
      if (
        !info.isDirectory() ||
        (process.getuid && info.uid !== process.getuid())
      )
        throw new Error();
      if (process.platform !== "win32") chmodSync(directory, 0o700);
    }
    for (const path of [
      join(profile, "connection.json"),
      join(profile, "coordination.sqlite"),
    ]) {
      if (existsSync(path) && !lstatSync(path).isFile()) throw new Error();
    }
  } catch {
    throw new ConnectionError("profile_unavailable");
  }
}

/**
 * Coordinates one OS user's saved parish connection and session.
 * Owns sign-in, session lifecycle, auth-failure diagnostics and write outcomes;
 * shared resource models own domain requests and parsing. Operations run
 * through the supplied coordinator's serialized queue.
 */
export class ParishConnection {
  readonly #profile: string;
  readonly #metadata: string;
  readonly #coordinator: SessionCoordinator;
  readonly #factory: SessionFactory;
  readonly #setupMs: number;
  readonly #pollMs: number;
  readonly #connectWaitMs: number;
  readonly #now: () => number;
  #session:
    | { generation: string; interactive: boolean; session: FlocknoteSession }
    | undefined;
  #network: { generation: string; model: Network } | undefined;
  #setup:
    | {
        controller: AbortController;
        task: Promise<void>;
        parish: string;
        started: Promise<ConnectionStatus>;
      }
    | undefined;

  constructor(options: {
    profile?: string;
    factory: SessionFactory;
    setupMs?: number;
    pollMs?: number;
    /** How long connect waits for another operation on the connection. */
    connectWaitMs?: number;
    coordinator: SessionCoordinator;
    now?: () => number;
  }) {
    this.#profile =
      options.profile ?? join(connectionProfileDirectory(), "browser-v1");
    this.#metadata = join(this.#profile, "connection.json");
    this.#coordinator = options.coordinator;
    this.#now = options.now ?? (() => performance.now());
    this.#factory = options.factory;
    this.#setupMs = options.setupMs ?? 5 * 60_000;
    this.#pollMs = options.pollMs ?? 1000;
    this.#connectWaitMs = options.connectWaitMs ?? 250;
  }

  toJSON(): object {
    return { type: "ParishConnection" };
  }
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return "ParishConnection {}";
  }

  #ensure(): void {
    prepareProfile(this.#profile);
  }

  /** The shared owner prepares the profile before taking its lifetime OS lock. */
  prepare(): void {
    this.#ensure();
  }

  async #dropSession(): Promise<void> {
    const current = this.#session;
    this.#session = undefined;
    this.#network = undefined;
    await current?.session.close();
  }

  async #open(
    saved: Connection,
    interactive: boolean,
  ): Promise<FlocknoteSession> {
    if (this.#session) {
      if (
        this.#session.generation === saved.generation &&
        (!interactive || this.#session.interactive) &&
        (this.#session.session.isOpen?.() ?? true)
      )
        return this.#session.session;
      await this.#dropSession();
    }
    const session = await this.#factory({
      profile: join(this.#profile, "browser"),
      origin: this.#networkFor(saved).origin,
      interactive,
    });
    this.#session = { generation: saved.generation, interactive, session };
    return session;
  }

  #read(): Connection | null {
    try {
      if (!existsSync(this.#metadata)) return null;
      if (!lstatSync(this.#metadata).isFile()) throw new Error();
      const value = JSON.parse(
        readFileSync(this.#metadata, "utf8"),
      ) as Connection;
      if (
        value.version !== 1 ||
        !/^[a-f0-9-]{36}$/.test(value.generation) ||
        normalizeSubdomain(value.parish) !== value.parish ||
        !["pending", "ready", "action_required"].includes(value.state) ||
        !(
          value.userId === null ||
          (typeof value.userId === "string" && /^[1-9]\d*$/.test(value.userId))
        ) ||
        (value.setupError !== undefined &&
          !SETUP_ERRORS.includes(value.setupError)) ||
        (value.setupStage !== undefined &&
          !SETUP_STAGES.includes(value.setupStage)) ||
        (value.owner !== undefined &&
          !(Number.isSafeInteger(value.owner) && value.owner > 0)) ||
        (value.state === "ready" && value.userId === null)
      )
        throw new Error();
      return value;
    } catch {
      throw new ConnectionError("profile_unavailable");
    }
  }

  #save(value: Connection): void {
    if (value.state !== "action_required") {
      const copy = { ...value };
      delete copy.setupError;
      delete copy.setupStage;
      value = copy;
    }
    if (value.state !== "pending") {
      const copy = { ...value };
      delete copy.owner;
      value = copy;
    }
    const temporary = join(this.#profile, `${randomUUID()}.json`);
    try {
      writeFileSync(temporary, `${JSON.stringify(value)}\n`, {
        mode: 0o600,
        flag: "wx",
      });
      renameSync(temporary, this.#metadata);
    } catch {
      throw new ConnectionError("profile_unavailable");
    } finally {
      rmSync(temporary, { force: true });
    }
  }

  async #exclusive<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    this.#ensure();
    try {
      return await this.#coordinator.runExclusive("browser", signal, work);
    } catch (error) {
      if (
        error instanceof QueueWaitTimeoutError ||
        error instanceof ProcessLockTimeoutError
      )
        throw new ConnectionError("connection_busy");
      throw error;
    }
  }

  /** Whether the saved record is still the pending one this setup wrote. */
  #claims(saved: Connection): boolean {
    try {
      const current = this.#read();
      return (
        current?.generation === saved.generation &&
        current.state === "pending" &&
        current.owner === process.pid
      );
    } catch {
      return false;
    }
  }

  #networkFor(saved: Connection): Network {
    if (!this.#network || this.#network.generation !== saved.generation) {
      this.#network = {
        generation: saved.generation,
        model: new Network(saved.parish, {
          cacheMs: 60_000,
          parallelReads: true,
          now: this.#now,
        }),
      };
    }
    return this.#network.model;
  }

  async #verify(session: FlocknoteSession, saved: Connection): Promise<void> {
    const userId = FlocknoteLogin.fromResponse(
      await session.request("user/userData"),
    ).id;
    if (saved.userId !== null && userId !== saved.userId)
      throw new ConnectionError("connection_changed");
  }

  async #operate<T>(
    options: OperationOptions,
    work: (
      session: FlocknoteSession,
      op: Operation,
      network: Network,
      connectionGeneration: string,
    ) => Promise<T>,
  ): Promise<T> {
    if (options.signal?.aborted) throw new FlockbotError("operation_cancelled");
    if (this.#setup) throw new ConnectionError("connection_busy");
    let acquired = false;
    const op = new Operation(
      { timeoutMs: 25_000, maxReadRetries: 0 },
      undefined,
      options,
    );
    try {
      return await op.run(() =>
        this.#exclusive(op.signal, async () => {
          acquired = true;
          op.check();
          const saved = this.#read();
          if (!saved) throw new ConnectionError("not_configured");
          if (saved.state !== "ready")
            throw new FlockbotError("authentication_required");
          const scope = operationParish.getStore();
          if (scope) scope.parish = saved.parish;
          const session = await this.#open(saved, false);
          try {
            op.check();
            return await work(
              session,
              op,
              this.#networkFor(saved),
              saved.generation,
            );
          } catch (error) {
            this.#network?.model.clearGroups();
            let failure = error;
            captureFailure(error);
            if (
              error instanceof AuthenticationSuspectedError &&
              !op.signal.aborted
            ) {
              // A successful operation never pays for a preflight. Only diagnose
              // an actual auth-like failure, without replaying the operation.
              op.check();
              beginAuthDiagnosis();
              try {
                await this.#verify(session, saved);
                endAuthDiagnosis("authenticated");
              } catch (verification) {
                if (requiresSignIn(verification)) failure = verification;
                endAuthDiagnosis(
                  requiresSignIn(verification)
                    ? "sign_in_required"
                    : verification instanceof FlockbotError &&
                        verification.code === "permission_denied"
                      ? "denied"
                      : "inconclusive",
                );
                // An unavailable/denied/unknown check cannot prove expiry. Keep
                // the original operation error and the saved connection.
              }
              op.check();
            }
            if (requiresSignIn(failure)) {
              this.#save({ ...saved, state: "action_required" });
              await this.#dropSession();
            }
            throw failure;
          }
        }),
      );
    } catch (error) {
      if (
        !acquired &&
        !options.signal?.aborted &&
        error instanceof FlockbotError &&
        error.code === "operation_timeout"
      )
        throw new ConnectionError("connection_busy");
      throw error;
    }
  }

  /**
   * Runs `work` and reports the parish its operations ran against, read
   * inside each operation's exclusive section, so a sign-out and another
   * parish's sign-in after it finishes can't relabel its result.
   */
  async inParish<T>(
    work: () => Promise<T>,
  ): Promise<{ value: T; parish?: string }> {
    const scope: { parish?: string } = {};
    const value = await operationParish.run(scope, work);
    return scope.parish === undefined
      ? { value }
      : { value, parish: scope.parish };
  }

  async status(options: OperationOptions = {}): Promise<ConnectionStatus> {
    if (options.signal?.aborted) throw new FlockbotError("operation_cancelled");
    if (!existsSync(this.#profile)) return { state: "not_configured" };
    this.#ensure();
    // An in-flight reconnect may still be queued behind work using an older
    // ready session. Don't let a waiting MCP call mistake that saved flag for
    // completion of the active sign-in attempt.
    if (this.#setup) return { state: "pending", parish: this.#setup.parish };
    let saved = this.#read();
    if (!saved) return { state: "not_configured" };
    if (saved.state === "pending" && !ownedElsewhere(saved.owner)) {
      try {
        await this.#exclusive(AbortSignal.timeout(100), async () => {
          saved = this.#read();
          if (saved?.state === "pending" && !ownedElsewhere(saved.owner)) {
            saved = { ...saved, state: "action_required" };
            this.#save(saved);
          }
        });
      } catch (error) {
        if (
          !(
            error instanceof ConnectionError && error.code === "connection_busy"
          ) &&
          !(
            error instanceof FlockbotError &&
            error.code === "operation_cancelled"
          )
        )
          throw error;
      }
      return {
        state: saved?.state ?? "not_configured",
        ...(saved
          ? {
              parish: saved.parish,
              ...(saved.setupError ? { setupError: saved.setupError } : {}),
              ...(saved.setupStage ? { setupStage: saved.setupStage } : {}),
            }
          : {}),
      };
    }
    return {
      state: saved.state,
      parish: saved.parish,
      ...(saved.state === "action_required" && saved.setupError
        ? { setupError: saved.setupError }
        : {}),
      ...(saved.state === "action_required" && saved.setupStage
        ? { setupStage: saved.setupStage }
        : {}),
    };
  }

  /** Returns once the real sign-in window is open; no credential enters MCP. */
  async connect(subdomain: string): Promise<ConnectionStatus> {
    const selected = normalizeSubdomain(subdomain);
    if (this.#setup) {
      if (this.#setup.parish !== selected)
        throw new ConnectionError("connection_changed");
      return this.#setup.started;
    }
    const controller = new AbortController();
    let resolveStarted: (value: ConnectionStatus) => void = () => undefined;
    let rejectStarted: (error: unknown) => void = () => undefined;
    const started = new Promise<ConnectionStatus>((resolve, reject) => {
      resolveStarted = resolve;
      rejectStarted = reject;
    });
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(this.#setupMs),
    ]);
    const task = (async () => {
      const setup: { saved?: Connection; session?: FlocknoteSession } = {};
      let ready = false;
      let lastFailure: SetupError | undefined;
      let failureStage: SetupStage | undefined;
      let authenticatedUser: string | undefined;
      try {
        await this.#exclusive(
          AbortSignal.any([signal, AbortSignal.timeout(this.#connectWaitMs)]),
          async () => {
            const previous = this.#read();
            if (previous && previous.parish !== selected)
              throw new ConnectionError("connection_changed");
            setup.saved = {
              version: 1,
              generation: previous?.generation ?? randomUUID(),
              parish: selected,
              userId: previous?.userId ?? null,
              state: "pending",
            };
            this.#save({
              ...setup.saved,
              state: "pending",
              owner: process.pid,
            });
            if (signal.aborted) throw new FlockbotError("operation_cancelled");
            this.#network?.model.clearGroups();
            setup.session = await this.#open(setup.saved, true);
            await setup.session.signIn();
          },
        );
        const saved = setup.saved as Connection;
        const session = setup.session as FlocknoteSession;
        resolveStarted({ state: "pending", parish: selected });
        while (!signal.aborted) {
          try {
            // The lock is held for each check, not while the person signs
            // in: the app signs in through its own connector, which needs
            // the lock to save the session.
            const userId = await this.#exclusive(
              AbortSignal.any([signal, AbortSignal.timeout(this.#pollMs)]),
              async () => {
                // Another connector replaced or forgot this setup's claim,
                // such as the app signing in itself. Its record stands.
                if (!this.#claims(saved)) return undefined;
                if (session.isOpen?.() === false)
                  throw new ConnectionError(
                    "browser_unavailable",
                    undefined,
                    "sign_in",
                  );
                const id = FlocknoteLogin.fromResponse(
                  await session.request("user/userData"),
                ).id;
                if (session.isOpen?.() === false)
                  throw new ConnectionError(
                    "browser_unavailable",
                    undefined,
                    "sign_in",
                  );
                return id;
              },
            );
            if (userId === undefined) break;
            if (saved.userId !== null && userId !== saved.userId) {
              // Keep sign-in open so the user can switch back on Flocknote.
              lastFailure = "connection_changed";
            } else {
              if (signal.aborted) break;
              authenticatedUser = userId;
              lastFailure = undefined;
              break;
            }
          } catch (error) {
            // Another connector is using the connection; check again later.
            if (
              !(
                error instanceof ConnectionError &&
                error.code === "connection_busy"
              )
            ) {
              lastFailure =
                error instanceof FlockbotError &&
                error.code === "authentication_required"
                  ? undefined
                  : setupFailure(error);
              // Poll failures during an interactive login are inconclusive.
              // Keep the user's window open until the setup deadline or
              // cancellation.
              if (
                error instanceof FlockbotError &&
                !(error instanceof AuthenticationSuspectedError) &&
                error.code === "permission_denied"
              )
                throw error;
              if (error instanceof ConnectionError) throw error;
            }
          }
          await delay(this.#pollMs, undefined, { signal }).catch(
            () => undefined,
          );
        }
      } catch (error) {
        lastFailure = setupFailure(error);
        if (error instanceof ConnectionError) failureStage = error.stage;
        throw error;
      } finally {
        const { saved, session } = setup;
        // Nothing was claimed when the connection was busy or changed.
        if (saved)
          await this.#exclusive(AbortSignal.timeout(25_000), async () => {
            // Another process may forget or replace the connection while this
            // setup runs. Only this setup's own pending record may take its
            // result, checked again right before each save.
            const ours = () => this.#claims(saved);
            if (!ours()) authenticatedUser = undefined;
            try {
              if (authenticatedUser !== undefined && !signal.aborted)
                await session?.finishSignIn?.();
              else await this.#dropSession();
              if (
                authenticatedUser !== undefined &&
                !signal.aborted &&
                ours()
              ) {
                this.#save({
                  ...saved,
                  userId: authenticatedUser,
                  state: "ready",
                });
                ready = true;
              }
            } catch (error) {
              lastFailure ??= setupFailure(error);
              if (error instanceof ConnectionError)
                failureStage ??= error.stage;
              // Setup may already have returned pending. Preserve its terminal
              // diagnostic below without replacing an earlier failure.
              rejectStarted(error);
            } finally {
              if (!ready && ours())
                this.#save({
                  ...saved,
                  state: "action_required",
                  setupError:
                    lastFailure ??
                    (controller.signal.aborted
                      ? "operation_cancelled"
                      : "operation_timeout"),
                  ...(failureStage ? { setupStage: failureStage } : {}),
                });
            }
          });
      }
    })()
      .catch((error: unknown) => {
        rejectStarted(error);
      })
      .finally(() => {
        this.#setup = undefined;
      });
    this.#setup = { controller, task, parish: selected, started };
    return started;
  }

  async groups(options: OperationOptions & { refresh?: boolean } = {}) {
    return this.#operate(options, (session, op, network) =>
      network.discoverGroups(this.#resources(session, op), options),
    );
  }

  #resources(session: FlocknoteSession, op: Operation) {
    const read = async (
      path: string,
      method: "GET" | "POST",
      body?: string,
      writeEntry = false,
      photo?: DraftImage,
    ) => {
      const data = photo
        ? await session.request(path, method, body, photo)
        : await session.request(path, method, body);
      validationSource(path);
      try {
        return accepted(data, path === "dashboard", writeEntry);
      } catch (error) {
        validationError(error, path);
        throw error;
      }
    };
    return {
      read: (path: string) => read(path, "GET"),
      query: async (path: string, body?: string) => {
        op.check();
        const value = await read(path, "POST", body);
        op.check();
        return value;
      },
      compose: (path: string, body: string) => {
        op.check();
        return read(
          path,
          "POST",
          body,
          /^network\/\d+\/writeNewNote\?ajax$/.test(path),
        );
      },
      upload: (photo: DraftImage) => {
        op.check();
        return read("upload/photo/note", "POST", undefined, false, photo);
      },
      check: () => op.check(),
      validationSource,
    };
  }

  async note(input: NoteInput, options: OperationOptions = {}) {
    const note = new Note(input);
    return this.#operate(options, async (session, op, network) => {
      const result = await note.read(this.#resources(session, op));
      return {
        ...result,
        url: result.reason === null ? network.noteUrl(result.noteId) : null,
      };
    });
  }

  async createEmailDraft(
    input: EmailDraftInput,
    options: OperationOptions = {},
  ) {
    const draft = new EmailDraft(input);
    return this.#writeDraft(draft, options, async (session, op, network) => {
      const images = new DraftImages();
      try {
        await images.prepare(draft.toInput(), () => op.check());
        const resources = this.#resources(session, op);
        const result = await draft.create(
          {
            ...resources,
            uploadImage: async (path) => {
              const photo = await images.read(path);
              return resources.upload(photo);
            },
          },
          network,
        );
        return { ...result, url: network.noteUrl(result.noteId) };
      } finally {
        await images.close();
      }
    });
  }

  async duplicateEmailDraft(
    input: EmailDuplicationInput,
    options: OperationOptions = {},
  ) {
    const draft = new EmailDuplication(input);
    return this.#writeDraft(draft, options, async (session, op, network) => {
      const result = await draft.create(this.#resources(session, op), network);
      return { ...result, url: network.noteUrl(result.noteId) };
    });
  }

  async #writeDraft<T>(
    draft: EmailDraft | EmailDuplication,
    options: OperationOptions,
    work: (
      session: FlocknoteSession,
      op: Operation,
      network: Network,
    ) => Promise<T>,
  ) {
    try {
      return await this.#operate(options, work);
    } catch (error) {
      const outcome = draft.submitted ? "unknown" : "not_submitted";
      if (error instanceof ConnectionError)
        throw new ConnectionError(
          error.code,
          outcome,
          error.stage,
          draft.progress,
        );
      throw new FlockbotError(
        error instanceof FlockbotError ? error.code : "operation_failed",
        error instanceof FlockbotError ? error.status : undefined,
        outcome,
        error instanceof FlockbotError ? error.response : undefined,
        error instanceof FlockbotError ? error.reason : undefined,
        draft.progress,
      );
    }
  }

  async findNotes(input: NoteSearchInput, options: OperationOptions = {}) {
    const search = new NoteSearch(input);
    return this.#operate(options, async (session, op, network) => {
      const result = await search.find(this.#resources(session, op));
      return {
        ...result,
        notes: result.notes.map((note) => ({
          ...note,
          url: network.noteUrl(note.id),
        })),
      };
    });
  }

  async memberFilters(
    input: MemberFiltersInput = {},
    options: OperationOptions = {},
  ) {
    const catalog = new MemberFilters(input);
    return this.#operate(options, (session, op, network) =>
      catalog.read(this.#resources(session, op), network),
    );
  }

  async findMembers<T extends MemberSearchInput>(
    input: T,
    options: OperationOptions = {},
  ) {
    // Snapshot/validate before waiting for coordination or opening a browser.
    const search = new MemberSearch(input);
    return this.#operate(
      options,
      (session, op, network, connectionGeneration) =>
        search.find(this.#resources(session, op), network, {
          connectionGeneration,
        }),
    );
  }

  async member(
    userId: string,
    fields: readonly MemberField[] = [],
    options: OperationOptions = {},
  ) {
    const profile = new MemberProfile(userId, fields);
    return this.#operate(options, (session, op) =>
      profile.read(this.#resources(session, op)),
    );
  }

  async memberGroups(userId: string, options: OperationOptions = {}) {
    const groups = new MemberGroups(userId);
    return this.#operate(options, (session, op) =>
      groups.list(this.#resources(session, op)),
    );
  }

  async memberCommunicationStatus(
    input: MemberCommunicationInput,
    options: OperationOptions = {},
  ) {
    const diagnostic = new MemberCommunicationStatus(input);
    return this.#operate(options, (session, op, network) =>
      diagnostic.read(this.#resources(session, op), network),
    );
  }

  async memberLatestEmailStatus(
    input: MemberLatestEmailInput,
    options: OperationOptions = {},
  ) {
    const lookup = new MemberLatestEmailStatus(input);
    return this.#operate(options, (session, op, network) =>
      lookup.read(this.#resources(session, op), network),
    );
  }

  async emailAnalytics(
    input: EmailAnalyticsInput,
    options: OperationOptions = {},
  ) {
    const analytics = new EmailAnalytics(input);
    return this.#operate(options, (session, op, network) =>
      analytics.read(this.#resources(session, op), network),
    );
  }

  async groupNotes(input: GroupSelector, options: OperationOptions = {}) {
    const messages = new GroupNotes(input);
    return this.#operate(options, async (session, op, network) => {
      const result = await messages.list(this.#resources(session, op), network);
      return {
        ...result,
        notes: result.notes.map((note) => ({
          ...note,
          url: note.status === "published" ? network.noteUrl(note.id) : null,
        })),
      };
    });
  }

  async emailRecipients(
    input: EmailRecipientsInput,
    options: OperationOptions = {},
  ) {
    const lookup = new EmailRecipients(input);
    return this.#operate(options, (session, op) =>
      lookup.read(this.#resources(session, op)),
    );
  }

  async groupMembers(input: GroupMembersInput, options: OperationOptions = {}) {
    const page = new GroupMembers(input);
    return this.#operate(options, (session, op, network) =>
      page.list(this.#resources(session, op), network),
    );
  }

  async isMember(
    userId: string,
    selector: GroupSelector,
    options: OperationOptions = {},
  ) {
    const groups = new MemberGroups(userId);
    const selected = membershipGroupSelector(selector);
    return this.#operate(options, (session, op, network) =>
      groups.check(this.#resources(session, op), network, selected),
    );
  }

  async count(
    groupId: string,
    options: OperationOptions = {},
  ): Promise<number> {
    let id: string;
    try {
      id = identifier(groupId);
    } catch {
      throw new FlockbotError("invalid_input");
    }
    return this.#operate(options, (session, op) =>
      Group.readSubscriberCount(this.#resources(session, op), id),
    );
  }

  async addMember(
    groupId: string,
    member: MemberInput,
    options: OperationOptions = {},
  ) {
    return this.#add({ groupId }, member, options);
  }

  async addMemberByName(
    groupName: string,
    member: MemberInput,
    options: OperationOptions = {},
  ) {
    return this.#add(
      { groupName: normalizedGroupName(groupName) },
      member,
      options,
    );
  }

  async #add(
    selector: { groupId: string } | { groupName: string },
    member: MemberInput,
    options: OperationOptions,
  ) {
    // Snapshot contact fields before waiting for coordination or opening a browser.
    const user = new User(member);
    const knownMembership =
      "groupId" in selector
        ? new GroupMembership(selector.groupId, user)
        : undefined;
    let submitted = false;
    try {
      return await this.#operate(options, async (session, op, network) => {
        const membership =
          knownMembership ??
          new GroupMembership(
            (
              await network.findGroup(
                this.#resources(session, op),
                "groupName" in selector ? selector.groupName : "",
              )
            ).id,
            user,
          );
        return membership.add(async (request, parse) => {
          op.check();
          submitted = true;
          const data = accepted(
            await session.request(request.path, "POST", request.body),
          );
          op.check();
          return parse(data);
        });
      });
    } catch (error) {
      if (error instanceof FlockbotError)
        throw new FlockbotError(
          error.code,
          error.status,
          submitted ? "unknown" : "not_submitted",
          undefined,
          error.reason,
        );
      if (error instanceof ConnectionError)
        throw new ConnectionError(
          error.code,
          submitted ? "unknown" : "not_submitted",
          error.stage,
        );
      if (submitted) throw new FlockbotError("write_outcome_unknown");
      throw new FlockbotError("operation_failed", undefined, "not_submitted");
    }
  }

  /**
   * Explicit operator operation, intentionally outside ordinary MCP tools.
   * `clearCredential` removes saved credentials the factory's storage holds,
   * inside the same exclusive section, before anything else is dropped.
   * `unlessReady` keeps a signed-in connection, or no connection, as it is.
   */
  async forget(
    clearCredential?: () => Promise<void>,
    options: { unlessReady?: boolean } = {},
  ): Promise<void> {
    this.#setup?.controller.abort();
    await this.#setup?.task;
    await this.#exclusive(AbortSignal.timeout(25_000), async () => {
      if (options.unlessReady) {
        const saved = this.#read();
        if (!saved || saved.state === "ready") return;
      }
      await clearCredential?.();
      await this.#dropSession();
      rmSync(join(this.#profile, "browser"), { recursive: true, force: true });
      rmSync(this.#metadata, { force: true });
    });
  }

  async close(): Promise<void> {
    this.#setup?.controller.abort();
    await this.#setup?.task;
    await this.#coordinator.runExclusive(
      "browser",
      new AbortController().signal,
      () => this.#dropSession(),
    );
  }
}
