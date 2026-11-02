import { version, type App } from "zapier-platform-core";
import { createAuthentication } from "./authentication.js";

const app = {
  version: "0.0.0",
  platformVersion: version,
  authentication: createAuthentication(),
  flags: { skipHttpPatch: true },
} satisfies App;

export default app;
