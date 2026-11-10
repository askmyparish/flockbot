import { BrowserService, runBrowserBroker } from "./browser-broker.js";
import { serveFlocknote } from "./flocknote-server.js";
import { FailureLog } from "./failure-log.js";

const entry = process.argv[1] ?? "";
try {
  if (process.argv[2] === "broker") await runBrowserBroker({ entry });
  else if (process.argv[2] === "diagnostics") {
    const records = await new FailureLog().read();
    if (records === undefined) {
      process.stderr.write("Local diagnostic storage is unavailable.\n");
      process.exitCode = 1;
    } else process.stdout.write(records);
  } else {
    const connection = new BrowserService({ entry });
    if (process.argv[2] === "forget") {
      await connection.forget();
      await connection.shutdown();
      process.stdout.write(
        "The local browser connection was forgotten. Flocknote's server-side session was not revoked.\n",
      );
    } else if (process.argv[2] === "stop") {
      await connection.shutdown();
      process.stdout.write(
        "The local browser owner was stopped. The saved connection is retained.\n",
      );
    } else await serveFlocknote(connection);
  }
} catch {
  process.stderr.write(
    "The local Flockbot operation could not complete. Check other local operations and run plugin setup if needed.\n",
  );
  process.exitCode = 1;
}
