import { join } from "node:path";
import { BrowserConnection } from "./browser-connection.js";
import { serveFlocknote } from "./flocknote-server.js";
import { httpSessionFactory } from "./http-session.js";
import { connectionProfileDirectory } from "./profile.js";
import { SerialCoordinator } from "./serial-coordinator.js";

// Runs in the assistant's own Node process: no browser runtime, no owner
// process. The connection lives beside, not inside, the browser-backed profile.
async function main(): Promise<void> {
  const connection = new BrowserConnection({
    profile: join(connectionProfileDirectory(), "http-v1"),
    factory: httpSessionFactory(),
    coordinator: new SerialCoordinator(),
  });
  if (process.argv[2] === "forget") {
    await connection.forget();
    process.stdout.write(
      "The saved Flocknote sign-in on this computer was forgotten. Flocknote's server-side session was not revoked.\n",
    );
    return;
  }
  await serveFlocknote(connection, { signIn: "local_page", updates: false });
}

main().catch(() => {
  process.stderr.write("The local Flockbot connector could not start.\n");
  process.exitCode = 1;
});
