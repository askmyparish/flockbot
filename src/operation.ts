import { FlockbotError } from "./errors.js";

export interface OperationOptions {
  readonly signal?: AbortSignal;
}

export interface OperationPolicy {
  readonly timeoutMs: number;
  /** Total transient GET retries across the operation, including verification. */
  readonly maxReadRetries: number;
  readonly readBackoffMs: number;
}

/** now must be monotonic; timers must fire even while an external promise hangs. */
export interface OperationClock {
  now(): number;
  schedule(delayMs: number, callback: () => void): () => void;
}

const defaultClock: OperationClock = {
  now: () => performance.now(),
  schedule: (ms, callback) => {
    const timer = setTimeout(callback, ms);
    return () => clearTimeout(timer);
  },
};

/**
 * One deadline, cancellation signal and read-retry budget for a logical operation.
 * Can return promptly when a dependency ignores cancellation. The coordinator
 * must separately retain its lock until that dependency and callback settle.
 */
export class Operation {
  readonly signal: AbortSignal;
  readonly policy: OperationPolicy;
  readonly #controller = new AbortController();
  readonly #clock: OperationClock;
  readonly #deadline: number;
  readonly #cancelTimer: () => void;
  readonly #removeListener: () => void;
  #reason: "operation_timeout" | "operation_cancelled" = "operation_timeout";
  #retries = 0;

  constructor(
    policy: Partial<OperationPolicy> = {},
    clock = defaultClock,
    options: OperationOptions = {},
  ) {
    this.policy = {
      timeoutMs: 20_000,
      maxReadRetries: 1,
      readBackoffMs: 200,
      ...policy,
    };
    if (
      !Number.isFinite(this.policy.timeoutMs) ||
      this.policy.timeoutMs <= 0 ||
      !Number.isSafeInteger(this.policy.maxReadRetries) ||
      this.policy.maxReadRetries < 0 ||
      this.policy.maxReadRetries > 5 ||
      !Number.isFinite(this.policy.readBackoffMs) ||
      this.policy.readBackoffMs < 0
    ) {
      throw new FlockbotError("invalid_configuration");
    }
    this.#clock = clock;
    this.#deadline = clock.now() + this.policy.timeoutMs;
    this.signal = this.#controller.signal;
    const cancel = () => {
      this.#reason = "operation_cancelled";
      this.#controller.abort();
    };
    options.signal?.addEventListener("abort", cancel, { once: true });
    this.#removeListener = () =>
      options.signal?.removeEventListener("abort", cancel);
    this.#cancelTimer = clock.schedule(this.policy.timeoutMs, () =>
      this.#controller.abort(),
    );
    if (options.signal?.aborted) cancel();
  }

  check(): void {
    if (this.signal.aborted || this.#clock.now() >= this.#deadline) {
      throw new FlockbotError(this.#reason);
    }
  }

  /** Return on deadline even if a host ignores abort. The coordinated callback
   * itself must stay locked until it settles, and checks prevent late writes. */
  async run<T>(work: () => Promise<T>): Promise<T> {
    let abort: () => void = () => undefined;
    try {
      this.check();
      const stopped = new Promise<never>((_, reject) => {
        abort = () => reject(new FlockbotError(this.#reason));
        this.signal.addEventListener("abort", abort, { once: true });
      });
      return await Promise.race([work(), stopped]);
    } finally {
      this.signal.removeEventListener("abort", abort);
      // A failed coordinator may settle before its callback. Stop that callback
      // at its next check rather than allowing work after the public result.
      this.#controller.abort();
      this.#cancelTimer();
      this.#removeListener();
    }
  }

  async retry(): Promise<boolean> {
    this.check();
    if (this.#retries >= this.policy.maxReadRetries) return false;
    const delay = this.policy.readBackoffMs * 2 ** this.#retries++;
    if (this.#clock.now() + delay >= this.#deadline)
      throw new FlockbotError("operation_timeout");
    await new Promise<void>((resolve, reject) => {
      const cancelTimer = this.#clock.schedule(delay, finish);
      const signal = this.signal;
      function finish() {
        signal.removeEventListener("abort", abort);
        resolve();
      }
      function abort() {
        cancelTimer();
        reject(new FlockbotError("operation_cancelled"));
      }
      signal.addEventListener("abort", abort, { once: true });
    });
    this.check();
    return true;
  }
}
