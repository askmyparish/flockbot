import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
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
import { SerialCoordinator } from "./serial-coordinator.js";

// Spike: the local connector compiled with `bun build --compile`, keeping the
// session in the login Keychain instead of a file. Bun.secrets is Bun-only.
//
//   bun build --compile --target=bun-darwin-arm64 \
//     --define 'BUILD_LABEL="<label>"' adapters/mcp/src/keychain-main.ts \
//     --outfile adapters/mcp/artifacts/keychain-spike/flockbot-mcp
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

function keychain(name: string): SessionBlob {
  return {
    get: () => Bun.secrets.get({ service: SERVICE, name }),
    set: (value) => Bun.secrets.set({ service: SERVICE, name, value }),
  };
}

const profile = join(connectionProfileDirectory(), "keychain-v1");

// Inside Flockbot.app, sign-in happens in the app's own window: connect opens
// the app, which signs in through this same binary's sign-in command.
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
const session = keychain("session");

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
    coordinator: new SerialCoordinator(),
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

async function main(): Promise<void> {
  const command = process.argv[2];
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
      ...(appBundle ? { openSignIn: () => openApp(appBundle) } : {}),
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
    coordinator: new SerialCoordinator(),
  });
  if (command === "status") {
    // Local state only: no Keychain read and no Flocknote request.
    const status = await connection.status();
    reply({ state: status.state, parish: status.parish ?? null });
    return;
  }
  if (command === "forget") {
    await connection.forget();
    // The connection removes only its profile folder; the cookie lives here.
    await Bun.secrets.delete({ service: SERVICE, name: "session" });
    process.stdout.write(
      "The saved Flocknote sign-in on this computer was forgotten. Flocknote's server-side session was not revoked.\n",
    );
    return;
  }
  await serveFlocknote(connection);
}

main().catch(() => {
  process.stderr.write("The local Flockbot connector could not start.\n");
  process.exitCode = 1;
});
