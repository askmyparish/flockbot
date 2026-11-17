import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ParishConnection } from "./connection.js";
import { FailureLog } from "./failure-log.js";
import { serveFlocknote } from "./flocknote-server.js";
import { httpSessionFactory, type SessionBlob } from "./http-session.js";
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
const session = keychain("session");

async function main(): Promise<void> {
  const command = process.argv[2];
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
