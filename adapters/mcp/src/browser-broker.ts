import {
  MAX_REQUEST,
  brokerRequestSchema,
  encodeFrame,
  decodeFrame,
  requestBroker,
  type BrokerRequest,
  type BrokerDescriptor,
  type BrokerReply,
} from "./browser-protocol.js";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  FlockbotError,
  MemberSearch,
  type MemberInput,
  type OperationOptions,
} from "../../../src/index.js";
import {
  BrowserConnection,
  prepareBrowserProfile,
  type BrowserStatus,
} from "./browser-connection.js";
import {
  BrowserConnectionError,
  type BrowserFactory,
} from "./browser-runtime.js";
import { ProcessLock, ProcessLockTimeoutError } from "./process-lock.js";
import { connectionProfileDirectory } from "./profile.js";
import { DpapiProtector } from "./dpapi.js";
import { SerialCoordinator } from "./serial-coordinator.js";

const PROTOCOL = 1;
// MCP hosts often omit TMPDIR from the child's environment. All Unix clients
// must resolve the same socket directory regardless of their launch environment.
// The random socket is mode 0600; its authentication key stays in the 0700 profile.
const SOCKET_DIRECTORY = "/tmp";
function profilePath(): string {
  return join(connectionProfileDirectory(), "browser-v1");
}
function descriptorPath(profile: string): string {
  return join(profile, "broker.json");
}
function runtimeIdentity(entry: string): string {
  return createHash("sha256").update(realpathSync(entry)).digest("hex");
}
function safeError(error: unknown): NonNullable<BrokerReply["error"]> {
  if (error instanceof FlockbotError || error instanceof BrowserConnectionError)
    return {
      kind: error instanceof FlockbotError ? "flockbot" : "browser",
      code: error.code,
      ...(error.outcome ? { outcome: error.outcome } : {}),
      ...(error instanceof BrowserConnectionError && error.stage
        ? { stage: error.stage }
        : {}),
    };
  return { kind: "browser", code: "broker_unavailable" };
}

async function readDescriptor(
  profile: string,
): Promise<BrokerDescriptor | null> {
  try {
    const file = descriptorPath(profile);
    if (!existsSync(file)) return null;
    const details = lstatSync(file);
    if (
      !details.isFile() ||
      details.size > 8192 ||
      (process.getuid && details.uid !== process.getuid()) ||
      (process.platform !== "win32" && (details.mode & 0o077) !== 0)
    )
      throw new Error();
    let text = readFileSync(file, "utf8");
    if (process.platform === "win32")
      text = await new DpapiProtector().unprotect(text);
    const value = JSON.parse(text) as BrokerDescriptor;
    if (
      value.version !== PROTOCOL ||
      !/^[a-f0-9]{64}$/.test(value.runtime) ||
      !/^[a-f0-9]{64}$/.test(value.key) ||
      typeof value.address !== "string"
    )
      throw new Error();
    if (process.platform === "win32") {
      if (!/^\\\\\.\\pipe\\flockbot-[a-f0-9]{32}$/.test(value.address))
        throw new Error();
    } else if (
      dirname(value.address) !== SOCKET_DIRECTORY ||
      !/^fb-[a-f0-9]{32}\.sock$/.test(value.address.split("/").at(-1) ?? "")
    )
      throw new Error();
    return value;
  } catch {
    throw new BrowserConnectionError("profile_unavailable");
  }
}

async function saveDescriptor(
  profile: string,
  descriptor: BrokerDescriptor,
): Promise<void> {
  let text = JSON.stringify(descriptor);
  if (process.platform === "win32")
    text = await new DpapiProtector().protect(text);
  const staged = join(profile, `broker-${process.pid}.tmp`);
  try {
    writeFileSync(staged, text, { flag: "wx", mode: 0o600 });
    renameSync(staged, descriptorPath(profile));
  } finally {
    rmSync(staged, { force: true });
  }
}

export interface BrokerOptions {
  entry: string;
  profile?: string;
  factory?: BrowserFactory;
  idleMs?: number;
  launch?: () => void;
}

/** One owner holds the existing OS lock for its whole browser lifetime. */
export async function runBrowserBroker(options: BrokerOptions): Promise<void> {
  const profile = options.profile ?? profilePath();
  const connection = new BrowserConnection({
    profile,
    ...(options.factory ? { factory: options.factory } : {}),
    coordinator: new SerialCoordinator(),
  });
  connection.prepare();
  const owner = new ProcessLock(join(profile, "coordination.sqlite"));
  await owner.runExclusive(
    "browser-owner",
    AbortSignal.timeout(25_000),
    async () => {
      // Only an owner of the OS lock may clean an abandoned socket/descriptor.
      const previous = await readDescriptor(profile);
      if (
        previous &&
        process.platform !== "win32" &&
        existsSync(previous.address)
      ) {
        const info = lstatSync(previous.address);
        if (
          info.isSocket() &&
          (!process.getuid || info.uid === process.getuid())
        )
          rmSync(previous.address);
      }
      const descriptor: BrokerDescriptor = {
        version: PROTOCOL,
        runtime: runtimeIdentity(options.entry),
        key: randomBytes(32).toString("hex"),
        address:
          process.platform === "win32"
            ? `\\\\.\\pipe\\flockbot-${randomBytes(16).toString("hex")}`
            : join(
                SOCKET_DIRECTORY,
                `fb-${randomBytes(16).toString("hex")}.sock`,
              ),
      };
      const seen = new Set<string>();
      let active = 0;
      let stopping = false;
      let browserClosed: Promise<void> | undefined;
      let idle: ReturnType<typeof setTimeout> | undefined;
      let resolveClosed: () => void = () => undefined;
      const closed = new Promise<void>((resolve) => {
        resolveClosed = resolve;
      });
      const stop = () => {
        if (!stopping) {
          stopping = true;
          if (idle) clearTimeout(idle);
          server.close(resolveClosed);
          browserClosed = connection.close();
          // stop() is also called by timers/signals; retain the rejection for
          // the main cleanup path without an unhandled background rejection.
          void browserClosed.catch(() => undefined);
        }
        return browserClosed;
      };
      const scheduleIdle = () => {
        if (idle) clearTimeout(idle);
        if (!stopping && active === 0)
          idle = setTimeout(
            () => {
              void stop();
            },
            options.idleMs ?? 5 * 60_000,
          );
      };
      const server = net.createServer((socket) => {
        socket.setEncoding("utf8");
        let buffer = "";
        let started = false;
        const controller = new AbortController();
        socket.on("error", () => undefined);
        socket.on("close", () => controller.abort());
        socket.setTimeout(35_000, () => socket.destroy());
        socket.on("data", (chunk) => {
          if (started) {
            socket.destroy();
            return;
          }
          buffer += chunk;
          if (Buffer.byteLength(buffer) > MAX_REQUEST) {
            socket.destroy();
            return;
          }
          const end = buffer.indexOf("\n");
          if (end < 0) return;
          started = true;
          let nonce: string;
          let request: BrokerRequest;
          try {
            const decoded = decodeFrame(
              buffer.slice(0, end),
              descriptor.key,
            ) as {
              nonce: string;
              request: unknown;
            };
            nonce = decoded.nonce;
            if (
              !/^[a-f0-9]{64}$/.test(nonce) ||
              seen.has(nonce) ||
              seen.size >= 4096
            )
              throw new Error();
            seen.add(nonce);
            request = brokerRequestSchema.parse(decoded.request);
          } catch {
            socket.destroy();
            return;
          }
          active++;
          if (idle) clearTimeout(idle);
          void (async () => {
            try {
              if (stopping)
                throw new BrowserConnectionError(
                  "broker_unavailable",
                  request.action === "add" ? "not_submitted" : undefined,
                );
              let value: unknown;
              const signal = controller.signal;
              switch (request.action) {
                case "ping":
                  value = { runtime: descriptor.runtime };
                  break;
                case "shutdown":
                  await stop();
                  value = { stopped: true };
                  break;
                case "status":
                  value = await connection.status({ signal });
                  break;
                case "connect":
                  value = await connection.connect(request.subdomain);
                  break;
                case "groups":
                  value = await connection.groups({
                    signal,
                    ...(request.refresh === undefined
                      ? {}
                      : { refresh: request.refresh }),
                  });
                  break;
                case "count":
                  value = await connection.count(request.groupId, { signal });
                  break;
                case "find_members": {
                  const { action: _, ...input } = request;
                  value = await connection.findMembers(input, { signal });
                  break;
                }
                case "forget":
                  await connection.forget();
                  value = { forgotten: true };
                  break;
                case "add":
                  if (Boolean(request.groupId) === Boolean(request.groupName))
                    throw new FlockbotError(
                      "invalid_input",
                      undefined,
                      "not_submitted",
                    );
                  value = request.groupId
                    ? await connection.addMember(
                        request.groupId,
                        request.member,
                        { signal },
                      )
                    : await connection.addMemberByName(
                        request.groupName ?? "",
                        request.member,
                        { signal },
                      );
                  break;
              }
              if (!socket.destroyed)
                socket.end(encodeFrame({ nonce, value }, descriptor.key));
            } catch (error) {
              if (!socket.destroyed)
                socket.end(
                  encodeFrame(
                    { nonce, error: safeError(error) },
                    descriptor.key,
                  ),
                );
            } finally {
              active--;
              // Rotate the owner's key before the replay ledger fills; never evict
              // accepted nonces while that key is usable.
              if (seen.size >= 4096 && active === 0) void stop();
              else scheduleIdle();
            }
          })();
        });
      });
      const onSignal = () => {
        void stop();
      };
      process.once("SIGINT", onSignal);
      process.once("SIGTERM", onSignal);
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(
            {
              path: descriptor.address,
              readableAll: false,
              writableAll: false,
            },
            () => resolve(),
          );
        });
        if (process.platform !== "win32") chmodSync(descriptor.address, 0o600);
        await saveDescriptor(profile, descriptor);
        scheduleIdle();
        await closed;
        await browserClosed;
      } finally {
        if (idle) clearTimeout(idle);
        process.removeListener("SIGINT", onSignal);
        process.removeListener("SIGTERM", onSignal);
        try {
          await connection.close();
        } finally {
          if (server.listening) server.close();
          rmSync(descriptorPath(profile), { force: true });
          if (process.platform !== "win32")
            rmSync(descriptor.address, { force: true });
        }
      }
    },
  );
}

/**
 * Per-MCP-process client for the shared local browser owner.
 * Discovers or starts the owner and relays authenticated, bounded IPC operations.
 * The owner retains browser/session state across client disconnects; closing this
 * proxy leaves that owner available until idle shutdown or an explicit stop.
 */
export class BrowserService {
  readonly #options: BrokerOptions;
  readonly #profile: string;
  readonly #runtime: string;
  #starting: Promise<BrokerDescriptor> | undefined;
  #descriptor: BrokerDescriptor | undefined;
  #descriptorStamp: string | undefined;

  constructor(options: BrokerOptions) {
    this.#options = options;
    this.#profile = options.profile ?? profilePath();
    this.#runtime = runtimeIdentity(options.entry);
  }

  toJSON(): object {
    return { type: "BrowserService" };
  }
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return "BrowserService {}";
  }

  async #owner(): Promise<BrokerDescriptor> {
    if (this.#descriptor && this.#stamp() === this.#descriptorStamp)
      return this.#descriptor;
    this.#descriptor = undefined;
    if (this.#starting) return this.#starting;
    this.#starting = this.#start()
      .then((descriptor) => {
        this.#descriptor = descriptor;
        this.#descriptorStamp = this.#stamp();
        return descriptor;
      })
      .finally(() => {
        this.#starting = undefined;
      });
    return this.#starting;
  }

  #stamp(): string | undefined {
    try {
      const info = lstatSync(descriptorPath(this.#profile));
      return `${info.ino}:${info.mtimeMs}:${info.size}:${info.mode}:${info.uid}`;
    } catch {
      return undefined;
    }
  }

  async #start(): Promise<BrokerDescriptor> {
    prepareBrowserProfile(this.#profile);
    const startup = new ProcessLock(join(this.#profile, "broker-start.sqlite"));
    try {
      return await startup.runExclusive(
        "broker-start",
        AbortSignal.timeout(25_000),
        async () => {
          const saved = await readDescriptor(this.#profile);
          if (saved) {
            let alive = false;
            try {
              await requestBroker(saved, { action: "ping" }, undefined, 500);
              alive = true;
            } catch {
              /* A dead owner is recovered below, never by replaying an operation. */
            }
            // Compatible clients share the owner even across package versions.
            // An idle shutdown or explicit local stop activates an updated runtime.
            if (alive) return saved;
          }
          if (this.#options.launch) this.#options.launch();
          else {
            const child = spawn(
              process.execPath,
              [
                "--disable-warning=ExperimentalWarning",
                this.#options.entry,
                "broker",
              ],
              { detached: true, stdio: "ignore", windowsHide: true },
            );
            child.once("error", () => undefined);
            child.unref();
          }
          const deadline = performance.now() + 25_000;
          while (performance.now() < deadline) {
            const ready = await readDescriptor(this.#profile);
            if (ready?.runtime === this.#runtime) {
              try {
                await requestBroker(ready, { action: "ping" }, undefined, 500);
                return ready;
              } catch {
                /* Wait for the new owner to publish/listen. */
              }
            }
            await delay(50);
          }
          throw new BrowserConnectionError("broker_unavailable");
        },
      );
    } catch (error) {
      if (error instanceof ProcessLockTimeoutError)
        throw new BrowserConnectionError("connection_busy");
      throw error;
    }
  }

  async #call(request: BrokerRequest, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted)
      throw new FlockbotError(
        "operation_cancelled",
        undefined,
        request.action === "add" ? "not_submitted" : undefined,
      );
    let owner: BrokerDescriptor;
    try {
      const starting = this.#owner();
      if (!signal) owner = await starting;
      else {
        let abort = () => {};
        try {
          owner = await new Promise<BrokerDescriptor>((resolve, reject) => {
            abort = () => reject(new FlockbotError("operation_cancelled"));
            signal.addEventListener("abort", abort, { once: true });
            starting.then(resolve, reject);
            if (signal.aborted) abort();
          });
        } finally {
          signal.removeEventListener("abort", abort);
        }
      }
    } catch (error) {
      if (request.action === "add") {
        if (error instanceof FlockbotError)
          throw new FlockbotError(error.code, undefined, "not_submitted");
        throw new BrowserConnectionError(
          error instanceof BrowserConnectionError
            ? error.code
            : "broker_unavailable",
          "not_submitted",
        );
      }
      throw error;
    }
    if (signal?.aborted)
      throw new FlockbotError(
        "operation_cancelled",
        undefined,
        request.action === "add" ? "not_submitted" : undefined,
      );
    try {
      return await requestBroker(owner, request, signal);
    } catch (error) {
      if (
        error instanceof BrowserConnectionError &&
        error.code === "broker_unavailable"
      )
        this.#descriptor = undefined;
      throw error;
    }
  }

  async status(options: OperationOptions = {}): Promise<BrowserStatus> {
    return (await this.#call(
      { action: "status" },
      options.signal,
    )) as BrowserStatus;
  }
  async connect(subdomain: string): Promise<BrowserStatus> {
    return (await this.#call({
      action: "connect",
      subdomain,
    })) as BrowserStatus;
  }
  async groups(options: OperationOptions & { refresh?: boolean } = {}) {
    return (await this.#call(
      {
        action: "groups",
        ...(options.refresh === undefined ? {} : { refresh: options.refresh }),
      },
      options.signal,
    )) as Awaited<ReturnType<BrowserConnection["groups"]>>;
  }
  async count(
    groupId: string,
    options: OperationOptions = {},
  ): Promise<number> {
    return (await this.#call(
      { action: "count", groupId },
      options.signal,
    )) as number;
  }
  async findMembers(
    input: Parameters<BrowserConnection["findMembers"]>[0],
    options: OperationOptions = {},
  ) {
    const prepared = new MemberSearch(input).toInput();
    return (await this.#call(
      {
        ...prepared,
        fields: [...(prepared.fields ?? [])],
        action: "find_members",
      },
      options.signal,
    )) as Awaited<ReturnType<BrowserConnection["findMembers"]>>;
  }
  async addMember(
    groupId: string,
    member: MemberInput,
    options: OperationOptions = {},
  ) {
    return (await this.#call(
      { action: "add", groupId, member: wireMember(member) },
      options.signal,
    )) as { success: true };
  }
  async addMemberByName(
    groupName: string,
    member: MemberInput,
    options: OperationOptions = {},
  ) {
    return (await this.#call(
      { action: "add", groupName, member: wireMember(member) },
      options.signal,
    )) as { success: true };
  }
  async forget(): Promise<void> {
    await this.#call({ action: "forget" });
  }
  async shutdown(): Promise<void> {
    const saved = await readDescriptor(this.#profile);
    this.#descriptor = undefined;
    if (!saved) return;
    await requestBroker(saved, { action: "shutdown" });
  }
  async close(): Promise<void> {
    /* The owner shuts down safely after its idle timeout. */
  }
}

function wireMember(member: MemberInput) {
  return {
    firstName: member.firstName,
    lastName: member.lastName,
    ...(typeof member.email === "string" ? { email: member.email } : {}),
    ...(typeof member.mobilePhone === "string"
      ? { mobilePhone: member.mobilePhone }
      : {}),
  };
}
