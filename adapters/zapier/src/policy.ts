// A real host configuration/reset generation is still a feasibility gate.
export const CONFIGURATION_VERSION = "credentials-v1";
// Leave nominal headroom for reporting/response overhead inside Zapier's 30s limit.
export const REQUEST_TIMEOUT_MS = 25_000;
export const CLIENT_POLICY = Object.freeze({
  timeoutMs: REQUEST_TIMEOUT_MS,
  maxReadRetries: 0,
});
