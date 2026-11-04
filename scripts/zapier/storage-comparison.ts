import { randomUUID } from "node:crypto";
import {
  ProbeStorageClient,
  StorageError,
  type StorageFetch,
  type StorageFailure,
} from "../../adapters/zapier/src/storage.js";
import { boundedText } from "./storage-diagnostic.js";
export const COMPARISON_CONSENT = "authorize-storage-comparison-diagnostic";
export const CONTENTION_CONSENT = "authorize-storage-contention-diagnostic";
export function comparisonHints(
  text: string,
  attempted: string,
  previous: string,
) {
  try {
    const value: unknown = JSON.parse(text);
    const object =
      value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    return {
      json: true,
      boolean: typeof value === "boolean" ? value : null,
      fields: [
        "success",
        "result",
        "updated",
        "matched",
        "value",
        "previous_value",
      ]
        .filter((k) => Object.hasOwn(object, k))
        .map((field) => ({
          field,
          boolean: typeof object[field] === "boolean" ? object[field] : null,
        })),
      containsAttempted:
        Object.values(object).includes(attempted) || value === attempted,
      containsPrevious:
        Object.values(object).includes(previous) || value === previous,
    };
  } catch {
    return { json: false };
  }
}
/** Isolated response experiment; never a session store or CAS proof. */
export async function compareStorage(
  config: { consent: string; dedicatedStore: boolean },
  secret: string,
  transport: StorageFetch = fetch,
) {
  const contention = config.consent === CONTENTION_CONSENT;
  if (
    (!contention && config.consent !== COMPARISON_CONSENT) ||
    config.dedicatedStore !== true
  )
    throw new StorageError("invalid_configuration");
  const key = `fbcmp_${randomUUID().replaceAll("-", "").slice(0, 22)}`;
  const markers = Array.from({ length: 4 }, () => `comparison-${randomUUID()}`);
  const [seed, next, stale, peer] = markers as [string, string, string, string];
  const pending = new Set<string>();
  const responses: {
    status: number;
    truncated: boolean;
    hints: ReturnType<typeof comparisonHints>;
    stage?: "contenderA" | "contenderB" | "stale";
  }[] = [];
  let sent = 0;
  let inFlight = 0;
  let clientOverlapObserved = false;
  const client = new ProbeStorageClient(secret, async (url, options) => {
    if (sent >= (contention ? 11 : 10))
      throw new StorageError("request_budget_exceeded");
    sent++;
    inFlight++;
    if (inFlight > 1) clientOverlapObserved = true;
    try {
      const response = await transport(url, options);
      if (options.method === "PATCH") {
        const data = JSON.parse(String(options.body)).data;
        const body = await boundedText(response);
        if (!options.signal?.aborted)
          responses.push({
            status: response.status,
            truncated: body.truncated,
            hints: comparisonHints(body.text, data.value, data.previous_value),
            ...(contention
              ? {
                  stage:
                    data.value === next
                      ? ("contenderA" as const)
                      : data.value === peer
                        ? ("contenderB" as const)
                        : ("stale" as const),
                }
              : {}),
          });
      }
      return response;
    } finally {
      inFlight--;
    }
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  let attempted = false,
    initialized = false,
    matchingApplied = false,
    stalePreserved = false;
  let cleanup: "not_needed" | "unconfirmed" | "confirmed" = "not_needed";
  let failure: StorageFailure | undefined;
  let singleWinnerObserved = false;
  let winnerIsA = false;
  let winnerIsB = false;
  async function read(signal: AbortSignal) {
    const value = await client.read(key, signal);
    if (value !== null) pending.delete(value);
    return value;
  }
  async function attempt(value: string) {
    pending.add(value);
    try {
      await client.setIf(key, seed, value, controller.signal);
    } catch (error) {
      // A received HTTP rejection still permits a readback. Unknown delivery stops.
      if (
        !(error instanceof StorageError && error.code === "storage_http_failed")
      )
        throw error;
    }
  }
  try {
    if ((await read(controller.signal)) !== null)
      throw new StorageError("storage_protocol_error");
    attempted = true;
    pending.add(seed);
    await client.initialize(key, seed, controller.signal);
    initialized = (await read(controller.signal)) === seed;
    if (!initialized) throw new StorageError("storage_protocol_error");
    let winner = next;
    if (contention) {
      const outcomes = await Promise.allSettled([attempt(next), attempt(peer)]);
      const unknown = outcomes.find((outcome) => outcome.status === "rejected");
      if (unknown?.status === "rejected") throw unknown.reason;
      const observed = await read(controller.signal);
      winnerIsA = observed === next;
      winnerIsB = observed === peer;
      matchingApplied = winnerIsA || winnerIsB;
      const a = responses.find((response) => response.stage === "contenderA");
      const b = responses.find((response) => response.stage === "contenderB");
      const success = (status: number | undefined) =>
        status !== undefined && status >= 200 && status < 300;
      singleWinnerObserved =
        (success(a?.status) && b?.status === 400 && winnerIsA) ||
        (success(b?.status) && a?.status === 400 && winnerIsB);
      if (winnerIsB) winner = peer;
    } else {
      await attempt(next);
      matchingApplied = (await read(controller.signal)) === next;
    }
    if (!matchingApplied) throw new StorageError("storage_protocol_error");
    await attempt(stale);
    stalePreserved = (await read(controller.signal)) === winner;
  } catch (error) {
    failure =
      error instanceof StorageError ? error.code : "storage_transport_failed";
  } finally {
    clearTimeout(timer);
    controller.abort();
    if (attempted) {
      cleanup = "unconfirmed";
      const c = new AbortController(),
        t = setTimeout(() => c.abort(), 2000);
      try {
        const current = await read(c.signal);
        if (current !== null && markers.includes(current)) {
          await client.remove(key, c.signal);
          if ((await read(c.signal)) === null && pending.size === 0)
            cleanup = "confirmed";
        }
      } catch {
        // Cleanup uncertainty remains explicit.
      } finally {
        clearTimeout(t);
        c.abort();
      }
    }
  }
  return {
    initialized,
    matchingApplied,
    stalePreserved,
    responses,
    observations: client.observations,
    cleanup,
    unresolvedWrites: pending.size,
    requests: sent,
    atomicityProven: false,
    ...(contention
      ? {
          contention: {
            singleWinnerObserved,
            winnerIsA,
            winnerIsB,
            clientOverlapObserved,
          },
        }
      : {}),
    ...(failure ? { failure } : {}),
  };
}
