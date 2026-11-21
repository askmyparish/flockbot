import { FailureLog } from "../../../adapters/mcp/src/failure-log.js";
import {
  runDiagnostic,
  failureDiagnostic,
} from "../../../adapters/mcp/src/diagnostics.js";
import { FlockbotError } from "../../../src/errors.js";

// The lock isn't fair, so under load one writer can wait past the short
// default while the others take turns. This checks that every save lands
// intact, not how quickly, so it waits as long as it needs to.
const log = new FailureLog({
  directory: process.argv[2] ?? "",
  lockWaitMs: 60_000,
});
const ids: string[] = [];
for (let i = 0; i < 10; i++) {
  const record = runDiagnostic("groups", () =>
    failureDiagnostic(new FlockbotError("invalid_response")),
  );
  if (!(await log.save(record))) throw new Error("Fictional writer failed");
  ids.push(record.operationId);
}
process.stdout.write(JSON.stringify(ids));
