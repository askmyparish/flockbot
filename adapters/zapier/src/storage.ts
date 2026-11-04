/** Experimental Storage REST boundary. Not wired into the shipped integration. */
export type StorageFailure =
  | "invalid_configuration"
  | "invalid_key"
  | "storage_http_failed"
  | "storage_protocol_error"
  | "storage_transport_failed"
  | "storage_timeout"
  | "storage_cancelled"
  | "request_budget_exceeded";

export class StorageError extends Error {
  constructor(
    readonly code: StorageFailure,
    readonly status?: number,
  ) {
    super(`Zapier Storage probe stopped (${code}).`);
    this.name = "StorageError";
  }
}

export type StorageFetch = (
  url: string,
  options: RequestInit,
) => Promise<Response>;

export interface StorageObservation {
  readonly status: number | null;
  readonly failure?: StorageFailure;
}

export class ProbeStorageClient {
  readonly #secret: string;
  readonly #fetch: StorageFetch;
  #requests = 0;
  readonly #observations: {
    status: number | null;
    failure?: StorageFailure;
  }[] = [];

  constructor(secret: string, transport: StorageFetch = fetch) {
    if (
      typeof secret !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        secret,
      )
    )
      throw new StorageError("invalid_configuration");
    this.#secret = secret;
    this.#fetch = transport;
  }

  get requests(): number {
    return this.#requests;
  }

  get observations(): readonly StorageObservation[] {
    return this.#observations.map((item) => ({ ...item }));
  }

  async #request(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    key: string,
    signal: AbortSignal,
    data?: { value: string; previous_value: string | null },
  ): Promise<unknown> {
    if (typeof key !== "string" || !/^[a-zA-Z0-9_-]{1,31}$/.test(key))
      throw new StorageError("invalid_key");
    if (signal.aborted) throw new StorageError("storage_cancelled");
    if (this.#requests >= 14) throw new StorageError("request_budget_exceeded");
    const url = new URL("https://store.zapier.com/api/records");
    if (method === "GET" || method === "DELETE")
      url.searchParams.set("key", key);
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 2_000);
    let rejectAbort = () => {};
    const observation: { status: number | null; failure?: StorageFailure } = {
      status: null,
    };
    try {
      const stopped = new Promise<never>((_, reject) => {
        rejectAbort = () =>
          reject(
            new StorageError(
              timedOut ? "storage_timeout" : "storage_cancelled",
            ),
          );
        controller.signal.addEventListener("abort", rejectAbort, {
          once: true,
        });
      });
      this.#requests++;
      this.#observations.push(observation);
      return await Promise.race([
        (async () => {
          const response = await this.#fetch(url.href, {
            method,
            redirect: "manual",
            credentials: "omit",
            signal: controller.signal,
            headers: {
              "X-Secret": this.#secret,
              ...(data ? { "Content-Type": "application/json" } : {}),
            },
            ...(data
              ? {
                  body: JSON.stringify(
                    method === "POST"
                      ? { [key]: data.value }
                      : {
                          action: "set_value_if",
                          data: { key, ...data },
                        },
                  ),
                }
              : {}),
          });
          observation.status = response.status;
          if (controller.signal.aborted)
            throw new StorageError("storage_cancelled");
          if (!response.ok)
            throw new StorageError("storage_http_failed", response.status);
          // Mutation responses are intentionally not interpreted as CAS proof.
          // The probe checks competing statuses AND separately reloads state.
          if (method !== "GET") return null;
          let result: unknown;
          try {
            result = await response.json();
          } catch {
            throw new StorageError("storage_protocol_error");
          }
          if (controller.signal.aborted)
            throw new StorageError("storage_cancelled");
          return result;
        })(),
        stopped,
      ]);
    } catch (error) {
      const failure = controller.signal.aborted
        ? new StorageError(timedOut ? "storage_timeout" : "storage_cancelled")
        : error instanceof StorageError
          ? error
          : new StorageError("storage_transport_failed");
      observation.failure = failure.code;
      throw failure;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      controller.signal.removeEventListener("abort", rejectAbort);
      controller.abort();
    }
  }

  async read(key: string, signal: AbortSignal): Promise<string | null> {
    const result = await this.#request("GET", key, signal);
    if (typeof result !== "object" || result === null || Array.isArray(result))
      throw new StorageError("storage_protocol_error");
    const keys = Object.keys(result);
    if (keys.length !== 0 && (keys.length !== 1 || keys[0] !== key))
      throw new StorageError("storage_protocol_error");
    const value = (result as Record<string, unknown>)[key];
    if (value === undefined || value === null) return null;
    if (typeof value !== "string" || value.length > 2_500)
      throw new StorageError("storage_protocol_error");
    return value;
  }

  async setIf(
    key: string,
    previous: string | null,
    value: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (
      (previous !== null && typeof previous !== "string") ||
      typeof value !== "string" ||
      new TextEncoder().encode(value).length >= 2_500 ||
      (previous !== null && new TextEncoder().encode(previous).length >= 2_500)
    )
      throw new StorageError("invalid_configuration");
    await this.#request("PATCH", key, signal, {
      value,
      previous_value: previous,
    });
  }

  /** Isolated experiment provisioning only; never recreate missing session state. */
  async initialize(
    key: string,
    value: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (
      typeof value !== "string" ||
      new TextEncoder().encode(value).length >= 2_500
    )
      throw new StorageError("invalid_configuration");
    await this.#request("POST", key, signal, { value, previous_value: null });
  }

  async remove(key: string, signal: AbortSignal): Promise<void> {
    await this.#request("DELETE", key, signal);
  }

  toJSON() {
    return { type: "ProbeStorageClient" };
  }
  [Symbol.for("nodejs.util.inspect.custom")]() {
    return "ProbeStorageClient { [REDACTED] }";
  }
}
