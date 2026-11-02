import { FlockbotError, type SessionCoordinator } from "../src/index.js";

/** Offline simulation only. Production adapters need cross-invocation fencing. */
export class FakeCoordinator implements SessionCoordinator {
  #tail: Promise<unknown> = Promise.resolve();
  async runExclusive<T>(
    _identity: string,
    signal: AbortSignal,
    work: () => Promise<T>,
  ): Promise<T> {
    const previous = this.#tail;
    let release = () => {};
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      if (signal.aborted) throw new FlockbotError("operation_cancelled");
      return await work();
    } finally {
      release();
    }
  }
}

export const coordinator = new FakeCoordinator();
