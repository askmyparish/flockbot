// Bundled separately from installable packages; shares the existing browser owner.
import { runBrowserBroker } from "../../adapters/mcp/src/browser-broker.js";

export { BrowserService } from "../../adapters/mcp/src/browser-broker.js";
export {
  diagnosticRuntime,
  runDiagnostic,
  verboseDiagnostic,
} from "../../adapters/mcp/src/diagnostics.js";
export { FailureLog } from "../../adapters/mcp/src/failure-log.js";
export { createFlocknoteServer } from "../../adapters/mcp/src/flocknote-server.js";

if (process.argv[2] === "broker" && process.argv[1])
  await runBrowserBroker({ entry: process.argv[1] });
