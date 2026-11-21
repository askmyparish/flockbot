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

/**
 * A release as a feed lists it: the version people see and, in a Sparkle
 * appcast, the build number that Sparkle orders releases by.
 */
export interface Release {
  readonly version: string;
  readonly build?: number;
}

/**
 * Orders releases the way the app's updater does: Sparkle by build number,
 * since a display version needn't change between builds; Velopack by version.
 */
export function compareReleases(
  a: Release,
  b: Release,
  format: FeedFormat,
): number | undefined {
  if (format === "velopack") return compareVersions(a.version, b.version);
  if (a.build === undefined || b.build === undefined) return undefined;
  return Math.sign(a.build - b.build);
}

/** The newest release a feed lists, or undefined when it lists none. */
export function newestInFeed(
  text: string,
  format: FeedFormat,
): Release | undefined {
  const releases =
    format === "appcast" ? appcastReleases(text) : velopackReleases(text);
  let newest: Release | undefined;
  for (const release of releases) {
    if (
      newest === undefined ||
      (compareReleases(release, newest, format) ?? 0) > 0
    )
      newest = release;
  }
  return newest;
}

function appcastReleases(text: string): Release[] {
  // One field of an item, as an element or as an enclosure attribute.
  const field = (item: string, name: string) =>
    new RegExp(
      `<sparkle:${name}>\\s*([^<\\s]+)\\s*</sparkle:${name}>|sparkle:${name}="([^"]+)"`,
    )
      .exec(item)
      ?.slice(1)
      .find((value) => value !== undefined);
  const releases: Release[] = [];
  for (const [item] of text.matchAll(/<item\b[\s\S]*?<\/item>/g)) {
    const build = field(item, "version");
    // build.sh numbers builds by commit count.
    if (build === undefined || !/^\d+$/.test(build)) continue;
    releases.push({
      version: field(item, "shortVersionString") ?? build,
      build: Number(build),
    });
  }
  return releases;
}

function velopackReleases(text: string): Release[] {
  let assets: unknown;
  try {
    assets = (JSON.parse(text) as { Assets?: unknown }).Assets;
  } catch {
    return [];
  }
  if (!Array.isArray(assets)) return [];
  return assets
    .map((asset) => (asset as { Version?: unknown } | null)?.Version)
    .filter(
      (version): version is string =>
        typeof version === "string" && versionPattern.test(version),
    )
    .map((version) => ({ version }));
}

interface CheckRecord {
  readonly checkedAt: number;
  readonly latest: Release;
}

/**
 * The connector's view of the update feed: the newest release from the last
 * check, kept in `file` so the next session knows it from its start.
 */
export class UpdateCheck {
  private record: CheckRecord | undefined;

  constructor(
    private readonly options: {
      readonly feed: string;
      readonly format: FeedFormat;
      /** This connector's own release; an appcast needs its build number. */
      readonly current: Release;
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
    return (compareReleases(
      latest,
      this.options.current,
      this.options.format,
    ) ?? 0) > 0
      ? latest.version
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
        headers: { "User-Agent": `Flockbot/${this.options.current.version}` },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) return;
      const text = await readBounded(response, MAX_FEED_BYTES);
      if (text === undefined) return;
      const latest = newestInFeed(text, this.options.format);
      if (latest === undefined) return;
      this.record = { checkedAt: now, latest };
      writeRecord(this.options.file, this.record);
    } catch {
      // Tried again next session.
    }
  }
}

/**
 * The body as text, or undefined once it passes `limit` bytes. It stops
 * reading there, so a huge or endless response can't fill memory.
 */
async function readBounded(
  response: Response,
  limit: number,
): Promise<string | undefined> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

function readRecord(file: string): CheckRecord | undefined {
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as {
      checkedAt?: unknown;
      latest?: { version?: unknown; build?: unknown };
    };
    const latest = value.latest;
    if (
      typeof value.checkedAt !== "number" ||
      typeof latest?.version !== "string" ||
      (latest.build !== undefined && typeof latest.build !== "number")
    )
      return undefined;
    return {
      checkedAt: value.checkedAt,
      latest: {
        version: latest.version,
        ...(latest.build !== undefined ? { build: latest.build } : {}),
      },
    };
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
