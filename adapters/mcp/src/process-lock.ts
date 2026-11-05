import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import type { SessionCoordinator } from "../../../src/index.js";

const SQLITE_BUSY = 5;
const POLL_MS = 50;

export class ProcessLockTimeoutError extends Error {
  readonly code = "lock_timeout";
  constructor() {
    super("Timed out waiting for the connector lock.");
    this.name = "ProcessLockTimeoutError";
  }
}

/**
 * An OS file lock held through SQLite on a dedicated database, never the state
 * database, so short state commits stay durable while the callback runs. The OS
 * releases it only when the holder finishes or dies; nothing expires it. Waiting
 * polls with busy_timeout 0 to keep the event loop free. Waiters aren't queued
 * fairly, and local-disk locking semantics are assumed.
 */
export class ProcessLock implements SessionCoordinator {
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  async runExclusive<T>(
    _identity: string,
    signal: AbortSignal,
    work: () => Promise<T>,
  ): Promise<T> {
    const database = await this.#acquire(signal);
    try {
      // Cancellation stops waiting only. A running callback keeps the lock until
      // it settles, even when its caller has already given up.
      return await work();
    } finally {
      try {
        database.exec("ROLLBACK");
      } finally {
        database.close();
      }
    }
  }

  async #acquire(signal: AbortSignal): Promise<DatabaseSync> {
    const database = new DatabaseSync(this.#path, { timeout: 0 });
    try {
      for (;;) {
        if (signal.aborted) throw new ProcessLockTimeoutError();
        try {
          database.exec("BEGIN EXCLUSIVE");
          return database;
        } catch (error) {
          if (!isBusy(error)) throw error;
        }
        await delay(POLL_MS, undefined, { signal }).catch(() => undefined);
      }
    } catch (error) {
      database.close();
      throw error;
    }
  }
}

function isBusy(error: unknown): boolean {
  const code = (error as { errcode?: unknown }).errcode;
  return typeof code === "number" && (code & 0xff) === SQLITE_BUSY;
}
