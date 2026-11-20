import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// The setup apps install updates, but only while their window is open, and
// people rarely open it once their assistants are connected. The connector
// runs whenever an assistant starts, so it reads the same update feed and
// lets the assistant tell the person to open Flockbot.

/** Sparkle's appcast on a Mac; a Velopack channel's releases list on Windows. */
export type FeedFormat = "appcast" | "velopack";

/** Checked at most this often; feeds change only when a release is published. */
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_FEED_BYTES = 5 * 1024 * 1024;

const versionPattern =
  /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Orders two release versions by semantic-version precedence, where
 * 0.3.0-dev.2 comes after 0.3.0-dev.1 and before 0.3.0. Returns undefined
 * when either isn't a version.
 */
export function compareVersions(a: string, b: string): number | undefined {
  const left = versionPattern.exec(a.trim());
  const right = versionPattern.exec(b.trim());
  if (!left || !right) return undefined;
  for (let i = 1; i <= 3; i++) {
    const difference = Number(left[i]) - Number(right[i]);
    if (difference !== 0) return Math.sign(difference);
  }
  return comparePrerelease(left[4], right[4]);
}

function comparePrerelease(
  a: string | undefined,
  b: string | undefined,
): number {
  if (a === b) return 0;
  // A release comes after any of its prereleases.
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  const left = a.split(".");
  const right = b.split(".");
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const x = left[i] as string;
    const y = right[i] as string;
    if (x === y) continue;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) return Math.sign(Number(x) - Number(y));
    // Numeric identifiers come before alphanumeric ones.
    if (xNumeric) return -1;
    if (yNumeric) return 1;
    return x < y ? -1 : 1;
  }
  return Math.sign(left.length - right.length);
}

/** The newest version a feed lists, or undefined when it lists none. */
export function newestInFeed(
  text: string,
  format: FeedFormat,
): string | undefined {
  let versions: unknown[];
  if (format === "appcast") {
    versions = [
      ...text.matchAll(
        /<sparkle:shortVersionString>\s*([^<\s]+)\s*<\/sparkle:shortVersionString>|sparkle:shortVersionString="([^"]+)"/g,
      ),
    ].map((match) => match[1] ?? match[2]);
  } else {
    try {
      const assets = (JSON.parse(text) as { Assets?: unknown }).Assets;
      versions = Array.isArray(assets)
        ? assets.map((asset) => (asset as { Version?: unknown })?.Version)
        : [];
    } catch {
      return undefined;
    }
  }
  let newest: string | undefined;
  for (const version of versions) {
    if (typeof version !== "string" || !versionPattern.test(version)) continue;
    if (newest === undefined || (compareVersions(version, newest) ?? 0) > 0)
      newest = version;
  }
  return newest;
}

interface CheckRecord {
  readonly checkedAt: number;
  readonly latest: string;
}

/**
 * The connector's view of the update feed: the newest version from the last
 * check, kept in `file` so the next session knows it from its start.
 */
export class UpdateCheck {
  private record: CheckRecord | undefined;

  constructor(
    private readonly options: {
      readonly feed: string;
      readonly format: FeedFormat;
      /** This connector's own version. */
      readonly current: string;
      readonly file: string;
      readonly now?: () => number;
      readonly fetch?: typeof fetch;
    },
  ) {
    this.record = readRecord(options.file);
  }

  /** A newer version than this one, if the last check found one. */
  available(): string | undefined {
    const latest = this.record?.latest;
    if (latest === undefined) return undefined;
    return (compareVersions(latest, this.options.current) ?? 0) > 0
      ? latest
      : undefined;
  }

  /**
   * Reads the feed unless the last check is under a day old. Never throws:
   * offline or a missing feed just waits for the next session.
   */
  async refresh(): Promise<void> {
    const now = (this.options.now ?? Date.now)();
    const checkedAt = this.record?.checkedAt;
    if (
      checkedAt !== undefined &&
      checkedAt <= now &&
      now - checkedAt < CHECK_INTERVAL_MS
    )
      return;
    try {
      const response = await (this.options.fetch ?? fetch)(this.options.feed, {
        headers: { "User-Agent": `Flockbot/${this.options.current}` },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) return;
      const text = await response.text();
      if (text.length > MAX_FEED_BYTES) return;
      const latest = newestInFeed(text, this.options.format);
      if (latest === undefined) return;
      this.record = { checkedAt: now, latest };
      writeRecord(this.options.file, this.record);
    } catch {
      // Tried again next session.
    }
  }
}

function readRecord(file: string): CheckRecord | undefined {
  try {
    const value = JSON.parse(
      readFileSync(file, "utf8"),
    ) as Partial<CheckRecord>;
    return typeof value.checkedAt === "number" &&
      typeof value.latest === "string"
      ? { checkedAt: value.checkedAt, latest: value.latest }
      : undefined;
  } catch {
    return undefined;
  }
}

function writeRecord(file: string, record: CheckRecord): void {
  // Several connectors can check at once; each replaces the file whole.
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
}
