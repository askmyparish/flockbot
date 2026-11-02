import { version, type App } from "zapier-platform-core";
import { createAuthentication } from "./authentication.js";
import { createActions, type CandidateTestDependencies } from "./actions.js";

/** Source-only factory for explicit offline models; npm main exports only App. */
export function createCandidateApp(
  dependencies: CandidateTestDependencies = {},
) {
  const actions = createActions(dependencies);
  return {
    version: "0.0.0",
    platformVersion: version,
    authentication: createAuthentication(dependencies.read),
    flags: { skipHttpPatch: true },
    ...actions,
  } satisfies App<typeof actions.triggers, typeof actions.creates>;
}
