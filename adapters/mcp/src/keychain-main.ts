import { execFile, spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  claudeDesktopRunning,
  disconnectForUninstall,
  runAssistantCommand,
  type Setup,
} from "./assistants.js";
import { ParishConnection } from "./connection.js";
import { FailureLog } from "./failure-log.js";
import { serveFlocknote } from "./flocknote-server.js";
import {
  httpSessionFactory,
  REQUEST_MS,
  type SessionBlob,
} from "./http-session.js";
import { FlockbotError } from "../../../src/index.js";
import { ConnectionError } from "./session.js";
import type { SignInResult } from "./sign-in-page.js";
import { connectionProfileDirectory } from "./profile.js";
import { ProcessLock } from "./process-lock.js";
import { UpdateCheck } from "./updates.js";
import { MCP_VERSION } from "./version.js";

// The connector the Flockbot apps bundle, compiled with `bun build --compile`
// by adapters/macos/build.sh and adapters/windows/build.sh. It keeps the
// session in the macOS Keychain or the Windows Credential Manager through
// Bun.secrets, which is Bun-only.
interface Secret {
  readonly service: string;
  readonly name: string;
}
declare const Bun: {
  secrets: {
    get(options: Secret): Promise<string | null>;
    set(options: Secret & { value: string }): Promise<void>;
    delete(options: Secret): Promise<boolean>;
  };
};

const SERVICE = "com.askmyparish.flockbot";
// Set with `bun build --define` so each build can be told apart.
declare const BUILD_LABEL: string | undefined;
const build = typeof BUILD_LABEL === "string" ? BUILD_LABEL : "unlabelled";
// The update feed the setup app installs from, set by its build script.
// Builds without one never check.
declare const UPDATE_FEED: string | undefined;
// The Mac app's CFBundleVersion, which Sparkle orders releases by.
declare const BUILD_NUMBER: string | undefined;

function keychain(name: string): SessionBlob {
  return {
    get: () => Bun.secrets.get({ service: SERVICE, name }),
    set: (value) => Bun.secrets.set({ service: SERVICE, name, value }),
  };
}

const profile = join(connectionProfileDirectory(), "keychain-v1");

/**
 * Each assistant and each app command runs its own connector process, and all
 * of them share one saved session. This OS lock lets only one of them sign in,
 * sign out or talk to Flocknote at a time, so none overwrites the cookies
 * another just saved or signs out in the middle of another's operation.
 */
function connectionLock(): ProcessLock {
  return new ProcessLock(join(profile, "connection.lock"));
}

// Inside Flockbot.app, or beside Flockbot.exe on Windows, sign-in happens in
// the app's own window: connect opens the app, which signs in through this
// same binary's sign-in command.
const appBundle = /^(.+\.app)\/Contents\/MacOS\/[^/]+$/.exec(
  process.execPath,
)?.[1];

function openApp(bundle: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("/usr/bin/open", [bundle], { timeout: 10_000 }, (error) =>
      error ? reject(error) : resolve(),
    );
  });
}

// On Windows the setup app is installed beside the connector. A second copy
// brings the open window forward instead of opening another.
const windowsApp =
  process.platform === "win32"
    ? join(dirname(process.execPath), "Flockbot.exe")
    : undefined;

function launchApp(path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(path, [], { detached: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

const openSignIn = appBundle
  ? () => openApp(appBundle)
  : windowsApp && existsSync(windowsApp)
    ? () => launchApp(windowsApp)
    : undefined;
const session = keychain("session");

/**
 * Only an installed copy can update: Flockbot.app on a Mac, or on Windows a
 * copy in Velopack's `current` folder, with Update.exe one level up.
 */
function updateCheck(): UpdateCheck | undefined {
  if (typeof UPDATE_FEED !== "string" || UPDATE_FEED === "") return undefined;
  const installed =
    appBundle !== undefined ||
    (windowsApp !== undefined &&
      existsSync(join(dirname(process.execPath), "..", "Update.exe")));
  if (!installed) return undefined;
  // Sparkle orders by build number, so a Mac copy can't compare without one.
  const buildNumber =
    typeof BUILD_NUMBER === "string" ? Number(BUILD_NUMBER) : Number.NaN;
  if (appBundle !== undefined && !Number.isInteger(buildNumber))
    return undefined;
  return new UpdateCheck({
    feed: UPDATE_FEED,
    format: appBundle ? "appcast" : "velopack",
    current: appBundle
      ? { version: MCP_VERSION, build: buildNumber }
      : { version: MCP_VERSION },
    file: join(connectionProfileDirectory(), "update-check.json"),
  });
}

/** Reads one bounded JSON object from stdin; the Mac app writes it there. */
async function readInput(): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin as AsyncIterable<Buffer>) {
    bytes += chunk.length;
    if (bytes > 8192) throw new Error();
    chunks.push(chunk);
  }
  // Decode once: a chunk boundary can split a multibyte character.
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error();
  return value as Record<string, unknown>;
}

function reply(value: object): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

/**
 * Signs in with credentials the Mac app collected in its own window, in place
 * of the browser page. The password reaches only Flocknote's login request.
 */
async function signIn(): Promise<void> {
  const input = await readInput();
  const { parish, email, password } = input;
  if (
    typeof parish !== "string" ||
    typeof email !== "string" ||
    typeof password !== "string" ||
    !parish.trim() ||
    !email.trim() ||
    !password
  ) {
    reply({ result: "incomplete" });
    return;
  }
  let outcome: SignInResult | undefined;
  const connection = new ParishConnection({
    profile,
    pollMs: 200,
    // Confirming the login is a request or two; the setup ends itself by then.
    setupMs: 2 * REQUEST_MS,
    // An assistant waiting for this sign-in holds the lock for one request
    // at a time; wait that out instead of reporting the connection busy.
    connectWaitMs: REQUEST_MS + 5_000,
    coordinator: connectionLock(),
    factory: httpSessionFactory({
      storage: () => session,
      open: async () => {},
      serve: async (options) => {
        outcome = await options.signIn({ email: email.trim(), password });
        return { url: "", close: async () => {} };
      },
    }),
  });
  try {
    // A sign-in that failed or expired still names its parish and login, and
    // the app offers Sign Out only once signed in. Signing in here replaces it.
    await forgetSignIn(connection, { unlessReady: true });
    await connection.connect(parish);
    // A rejected password never confirms, so report it without waiting.
    if (outcome !== "signed_in") {
      await connection.close();
      reply({ result: outcome ?? "failed" });
      return;
    }
    // The connection now confirms the login with user/userData. Wait for the
    // setup's own outcome; only a ready connection counts as signed in.
    let status = await connection.status();
    while (status.state === "pending") {
      await delay(200);
      status = await connection.status();
    }
    reply({
      result:
        status.state === "ready"
          ? "signed_in"
          : status.setupError === "connection_changed"
            ? "connection_changed"
            : "failed",
    });
  } catch (error) {
    reply({
      result:
        error instanceof ConnectionError && error.code === "connection_changed"
          ? "connection_changed"
          : error instanceof FlockbotError &&
              error.code === "invalid_configuration"
            ? "invalid_parish"
            : // A password Flocknote accepted is no success if setup then failed.
              outcome !== undefined && outcome !== "signed_in"
              ? outcome
              : "failed",
    });
  } finally {
    await connection.close();
  }
}

/** This connector's assistant entries, in this person's settings. */
const assistantSetup: Setup = {
  command: process.execPath,
  home: homedir(),
  environment: process.env,
  platform: process.platform,
  claudeDesktopOpen: () => claudeDesktopRunning(process.platform, process.env),
};

/** Deletes the saved cookie, then the connection that names it. */
async function forgetSignIn(
  connection: ParishConnection,
  options: { unlessReady?: boolean } = {},
): Promise<void> {
  // Delete the cookie first: if that fails, the connection still reads as
  // signed in rather than hiding a credential that is still stored.
  await connection.forget(async () => {
    await Bun.secrets.delete({ service: SERVICE, name: "session" });
  }, options);
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (
    command === "assistants" ||
    command === "connect" ||
    command === "disconnect" ||
    command === "repoint"
  ) {
    const result = runAssistantCommand(process.argv.slice(2), assistantSetup);
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exitCode = result.exitCode;
    return;
  }
  if (command === "sign-in") {
    await signIn();
    return;
  }
  if (command === "keychain-probe") {
    // Write, read back and delete a fictional value; prints no secrets.
    const probe = { service: SERVICE, name: "probe" };
    await Bun.secrets.set({ ...probe, value: "fictional-probe-value" });
    const read = await Bun.secrets.get(probe);
    const deleted =
      process.argv[3] === "--keep" ? false : await Bun.secrets.delete(probe);
    process.stdout.write(
      `${JSON.stringify({ roundTrip: read === "fictional-probe-value", deleted })}\n`,
    );
    return;
  }
  if (command === "session-info") {
    // Reports whether a session is saved, never its cookies.
    const text = await session.get();
    const saved = text
      ? (JSON.parse(text) as {
          revision: number;
          state: { cookies?: string[] } | null;
        })
      : null;
    process.stdout.write(
      `${JSON.stringify({
        build,
        saved: saved !== null,
        revision: saved?.revision ?? null,
        cookieNames:
          saved?.state?.cookies?.map((cookie) => cookie.split("=", 1)[0]) ?? [],
      })}\n`,
    );
    return;
  }
  if (command === "diagnostics") {
    const records = await new FailureLog().read();
    if (records === undefined) {
      process.stderr.write("Local diagnostic storage is unavailable.\n");
      process.exitCode = 1;
    } else process.stdout.write(records);
    return;
  }
  const connection = new ParishConnection({
    profile,
    factory: httpSessionFactory({
      storage: () => session,
      ...(openSignIn ? { openSignIn } : {}),
      // Spike test hook: hand the page address to a local test script
      // through an owner-only file instead of opening a browser.
      ...(process.env.FLOCKBOT_SPIKE_SIGN_IN_URL_FILE
        ? {
            open: async (url: string) =>
              writeFileSync(
                process.env.FLOCKBOT_SPIKE_SIGN_IN_URL_FILE as string,
                url,
                { mode: 0o600 },
              ),
          }
        : {}),
    }),
    coordinator: connectionLock(),
  });
  if (command === "status") {
    // Local state only: no Keychain read and no Flocknote request.
    const status = await connection.status();
    reply({ state: status.state, parish: status.parish ?? null });
    return;
  }
  if (command === "uninstall") {
    // For the Windows uninstaller, which allows little time: the saved
    // sign-in goes first, then every assistant entry. Replies with each
    // step's outcome for the uninstaller's log.
    let signIn = "forgotten";
    try {
      await forgetSignIn(connection);
    } catch {
      signIn = "failed";
    }
    reply({ signIn, assistants: disconnectForUninstall(assistantSetup) });
    return;
  }
  if (command === "forget") {
    await forgetSignIn(connection);
    process.stdout.write(
      "The saved Flocknote sign-in on this computer was forgotten. Flocknote's server-side session was not revoked.\n",
    );
    return;
  }
  const updates = updateCheck();
  // In the background: a slow or offline feed never delays the assistant.
  void updates?.refresh();
  await serveFlocknote(
    connection,
    updates ? { updateAvailable: () => updates.available() } : {},
  );
}

main().catch(() => {
  process.stderr.write("The local Flockbot connector could not start.\n");
  process.exitCode = 1;
});
