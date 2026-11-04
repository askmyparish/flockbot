import { randomUUID } from "node:crypto";
import {
  type ProbeStorageClient,
  StorageError,
  type StorageFailure,
  type StorageObservation,
} from "../../adapters/zapier/src/storage.js";
export { ProbeStorageClient } from "../../adapters/zapier/src/storage.js";

export const INITIALIZED_STORAGE_PROBE_CONSENT =
  "authorize-initialized-storage-probe";

export const STORAGE_PROBE_CONSENT = "authorize-isolated-storage-probe";

/** Nonsecret capability experiment; never accepts cookies or member inputs. */
export async function probeZapierStorage(
  config: { readonly consent: string; readonly dedicatedStore: boolean },
  client: ProbeStorageClient,
) {
  const initialized = config.consent === INITIALIZED_STORAGE_PROBE_CONSENT;
  if (
    (!initialized && config.consent !== STORAGE_PROBE_CONSENT) ||
    config.dedicatedStore !== true ||
    client.requests !== 0
  )
    throw new StorageError("invalid_configuration");
  const key = `fbprobe_${randomUUID().replaceAll("-", "").slice(0, 22)}`;
  const markers = Array.from({ length: 5 }, () => `probe-${randomUUID()}`);
  const [seed, overwrite, first, second, stale] = markers as [
    string,
    string,
    string,
    string,
    string,
  ];
  const start = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  const observations: Record<string, StorageObservation> = {};
  // Reconcile an uncertain mutation only by observing its unique marker.
  // Absence cannot rule out a late commit by a broken conditional service.
  const unresolved = new Set<string>();
  const checks = {
    initialized: false,
    ...(initialized ? {} : { nullOverwriteRejected: false }),
    singleWinner: false,
    staleUpdateRejected: false,
    reloaded: false,
  };
  let initializationAttempted = false;
  let cleanup: "confirmed" | "unconfirmed" | "not_needed" = "not_needed";
  let failure: StorageFailure | "probe_check_failed" | undefined;
  const check = (value: boolean) => {
    if (!value) throw new Error("Probe assertion failed.");
  };
  async function observe<T>(stage: string, work: () => Promise<T>): Promise<T> {
    const requestIndex = client.requests;
    let caught: StorageFailure | undefined;
    try {
      return await work();
    } catch (error) {
      if (error instanceof StorageError) caught = error.code;
      throw error;
    } finally {
      observations[stage] = {
        ...(client.observations[requestIndex] ?? { status: null }),
        ...(caught ? { failure: caught } : {}),
      };
    }
  }
  async function read(stage: string, signal: AbortSignal) {
    const current = await observe(stage, () => client.read(key, signal));
    if (current !== null) unresolved.delete(current);
    return current;
  }
  async function mutate(stage: string, previous: string | null, value: string) {
    const before = client.requests;
    unresolved.add(value);
    try {
      await observe(stage, () =>
        stage === "initialize" && initialized
          ? client.initialize(key, value, controller.signal)
          : client.setIf(key, previous, value, controller.signal),
      );
    } catch (error) {
      if (
        client.requests === before ||
        (!(stage === "initialize" && initialized) &&
          error instanceof StorageError &&
          error.code === "storage_http_failed" &&
          error.status === 400)
      )
        unresolved.delete(value);
      throw error;
    }
  }
  async function expectConflict(
    stage: string,
    previous: string | null,
    value: string,
  ) {
    try {
      await mutate(stage, previous, value);
      return false;
    } catch (error) {
      if (
        error instanceof StorageError &&
        error.code === "storage_http_failed" &&
        error.status === 400
      )
        return true;
      throw error;
    }
  }
  try {
    check((await read("initialRead", controller.signal)) === null);
    initializationAttempted = true;
    await mutate("initialize", null, seed);
    // Null must mean "absent", not "unconditional" on an existing key.
    if (!initialized)
      checks.nullOverwriteRejected = await expectConflict(
        "nullOverwrite",
        null,
        overwrite,
      );
    checks.initialized =
      (await read("initializedRead", controller.signal)) === seed;
    check(
      checks.initialized &&
        (initialized || checks.nullOverwriteRejected === true),
    );
    const results = await Promise.allSettled([
      mutate("contenderA", seed, first),
      mutate("contenderB", seed, second),
    ]);
    const winner = await read("winnerRead", controller.signal);
    const successes = results.flatMap((result, index) =>
      result.status === "fulfilled" ? [index] : [],
    );
    const conflicts = results.filter(
      (result) =>
        result.status === "rejected" &&
        result.reason instanceof StorageError &&
        result.reason.code === "storage_http_failed" &&
        result.reason.status === 400,
    );
    checks.singleWinner =
      successes.length === 1 &&
      conflicts.length === 1 &&
      winner === [first, second][successes[0] ?? -1];
    check(checks.singleWinner);
    checks.staleUpdateRejected = await expectConflict(
      "staleUpdate",
      seed,
      stale,
    );
    check(checks.staleUpdateRejected);
    checks.reloaded = (await read("reload", controller.signal)) === winner;
    check(checks.reloaded);
  } catch (error) {
    failure = error instanceof StorageError ? error.code : "probe_check_failed";
  } finally {
    clearTimeout(timer);
    controller.abort();
    if (initializationAttempted) {
      cleanup = "unconfirmed";
      const cleanupController = new AbortController();
      const cleanupTimer = setTimeout(() => cleanupController.abort(), 2_000);
      try {
        const current = await read("cleanupRead", cleanupController.signal);
        if (current !== null && markers.includes(current)) {
          await observe("cleanupDelete", () =>
            client.remove(key, cleanupController.signal),
          );
          if (
            (await read("cleanupVerify", cleanupController.signal)) === null &&
            unresolved.size === 0
          )
            cleanup = "confirmed";
        }
      } catch {
        cleanup = "unconfirmed";
      } finally {
        clearTimeout(cleanupTimer);
        cleanupController.abort();
      }
    }
  }
  return {
    passed:
      failure === undefined &&
      Object.values(checks).every(Boolean) &&
      cleanup === "confirmed",
    checks,
    observations,
    // A single client-side contention trial cannot prove server-side atomicity.
    atomicityProven: false,
    unresolvedWrites: unresolved.size,
    cleanup,
    ...(failure ? { failure } : {}),
    requests: client.requests,
    elapsedMs: Math.ceil(performance.now() - start),
  };
}
