import { fetchTransport, type Transport } from "../../../src/index.js";
import type { FailureStage } from "./failures.js";
import { REQUEST_TIMEOUT_MS } from "./policy.js";

interface RequestTiming {
  endpoint: string;
  method: "GET" | "POST";
  stage: FailureStage;
  started_ms: number;
  elapsed_ms?: number;
  state: "in_flight" | "responded" | "failed" | "aborted";
  http_status?: number;
}

/** Never log an origin, query, identifier, or unrecognized path. */
function endpointName(url: string): string {
  const path = new URL(url).pathname.slice(1);
  switch (path) {
    case "user/userData":
    case "dashboard":
    case "navigation/groups":
    case "network/getMetadata":
      return path;
    default:
      return /^group\/[^/]+\/addToGroupByAdmin$/.test(path)
        ? "group/:groupId/addToGroupByAdmin"
        : "other";
  }
}

/** Per-attempt metadata only; the caller emits one snapshot on failure/warning. */
export function membershipDiagnostics(
  stage: () => FailureStage,
  transport: Transport = fetchTransport,
) {
  const started = performance.now();
  const requests: RequestTiming[] = [];
  let truncated = false;
  const observedTransport: Transport = async (request) => {
    // Bound memory and console output independently of future request additions.
    if (requests.length >= 12) {
      truncated = true;
      return transport(request);
    }
    const requestStarted = performance.now();
    const timing: RequestTiming = {
      endpoint: endpointName(request.url),
      method: request.method,
      stage: stage(),
      started_ms: Math.round(requestStarted - started),
      state: "in_flight",
    };
    requests.push(timing);
    try {
      const response = await transport(request);
      timing.state = "responded";
      timing.http_status = response.status;
      return response;
    } catch (error) {
      timing.state = request.signal.aborted ? "aborted" : "failed";
      throw error;
    } finally {
      timing.elapsed_ms = Math.round(performance.now() - requestStarted);
    }
  };
  return {
    transport: observedTransport,
    snapshot: () => {
      const elapsed = Math.round(performance.now() - started);
      return {
        timeout_ms: REQUEST_TIMEOUT_MS,
        elapsed_ms: elapsed,
        requests_truncated: truncated,
        requests: requests.map((request) => ({
          ...request,
          // A hung dependency need not settle or honor abort to be identified.
          elapsed_ms: request.elapsed_ms ?? elapsed - request.started_ms,
        })),
      };
    },
  };
}
