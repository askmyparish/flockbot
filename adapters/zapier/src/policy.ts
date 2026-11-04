// A real host configuration/reset generation is still a feasibility gate.
export const CONFIGURATION_VERSION = "credentials-v1";
export const REQUEST_TIMEOUT_MS = 20_000;
export const CLIENT_POLICY = Object.freeze({
  timeoutMs: REQUEST_TIMEOUT_MS,
  maxReadRetries: 0,
});
