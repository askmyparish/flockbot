import { FlockbotError, type SessionCoordinator } from "../../../src/index.js";

/** A queue-wait deadline elapsed before its callback acquired coordination. */
export class QueueWaitTimeoutError extends Error {
  constructor() {
    super("Timed out waiting for the local operation queue.");
    this.name = "QueueWaitTimeoutError";
  }
}
function cancellationError(signal: AbortSignal): Error {
  return signal.reason instanceof DOMException &&
    signal.reason.name === "TimeoutError"
    ? new QueueWaitTimeoutError()
    : new FlockbotError("operation_cancelled");
}

/**
 * Serializes operations inside the process holding the browser profile's OS lock.
 * Cancelling a queued caller leaves the active holder intact. Running work keeps
 * its place in the queue until it settles, even after its caller cancels.
 */
export class SerialCoordinator implements SessionCoordinator {
  #tail: Promise<void> = Promise.resolve();

  async runExclusive<T>(
    _identity: string,
    signal: AbortSignal,
    work: () => Promise<T>,
  ): Promise<T> {
    const previous = this.#tail;
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#tail = previous.then(() => held);
    let abort: () => void = () => undefined;
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject(cancellationError(signal));
      signal.addEventListener("abort", abort, { once: true });
    });
    try {
      if (signal.aborted) throw cancellationError(signal);
      await Promise.race([previous, cancelled]);
    } catch (error) {
      // A cancelled waiter cannot release the active holder or a later waiter.
      void previous.then(release);
      throw error;
    } finally {
      signal.removeEventListener("abort", abort);
    }
    try {
      if (signal.aborted) throw cancellationError(signal);
      return await work();
    } finally {
      release();
    }
  }
}
