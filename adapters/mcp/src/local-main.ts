import { join } from "node:path";
import { ParishConnection } from "./connection.js";
import { FailureLog } from "./failure-log.js";
import { serveFlocknote } from "./flocknote-server.js";
import { httpSessionFactory } from "./http-session.js";
import { connectionProfileDirectory } from "./profile.js";
import { SerialCoordinator } from "./serial-coordinator.js";

// Runs in the assistant's own Node process. Sign-in uses a local page in the
// default browser; every Flocknote request after that is plain HTTP.
async function main(): Promise<void> {
  if (process.argv[2] === "diagnostics") {
    const records = await new FailureLog().read();
    if (records === undefined) {
      process.stderr.write("Local diagnostic storage is unavailable.\n");
      process.exitCode = 1;
    } else process.stdout.write(records);
    return;
  }
  const connection = new ParishConnection({
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
  await serveFlocknote(connection);
}

main().catch(() => {
  process.stderr.write("The local Flockbot connector could not start.\n");
  process.exitCode = 1;
});
