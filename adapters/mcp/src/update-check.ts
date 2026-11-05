import { closeSync, existsSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { dirname, join, parse, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { connectionProfileDirectory } from "./profile.js";
import { MCP_VERSION } from "./version.js";

export const UPDATE_GUIDE =
  "https://raw.githubusercontent.com/askmyparish/flockbot/main/guide.md";
export const RELEASES_URL =
  "https://api.github.com/repos/askmyparish/flockbot/releases?per_page=20";
const DAY = 24 * 60 * 60 * 1000;
const MAX_BODY = 1024 * 1024;
const VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

function version(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 100 ||
    VERSION.exec(value)?.[0] !== value
  )
    throw new Error("Invalid version");
  const pre = value.split(/-(.*)/s)[1];
  if (pre?.split(".").some((id) => /^0\d+$/.test(id)))
    throw new Error("Invalid version");
  return value;
}

/** Same restricted SemVer format as immutable setup releases (no build suffix). */
export function compareReleaseVersions(a: string, b: string): number {
  const parts = (v: string) => {
    const [release = "", pre] = version(v).split(/-(.*)/s);
    return { release: release.split(".").map(BigInt), pre: pre?.split(".") };
  };
  const x = parts(a),
    y = parts(b);
  for (let i = 0; i < 3; i++) {
    const n = x.release[i],
      m = y.release[i];
    if (n === undefined || m === undefined) throw new Error("Invalid version");
    if (n !== m) return n > m ? 1 : -1;
  }
  if (!x.pre || !y.pre) return x.pre === y.pre ? 0 : x.pre ? -1 : 1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const n = x.pre[i],
      m = y.pre[i];
    if (n === m) continue;
    if (n === undefined || m === undefined) return n === undefined ? -1 : 1;
    const numericN = /^\d+$/.test(n),
      numericM = /^\d+$/.test(m);
    if (numericN !== numericM) return numericN ? -1 : 1;
    if (numericN) return BigInt(n) > BigInt(m) ? 1 : -1;
    return n > m ? 1 : -1;
  }
  return 0;
}

export function newestSetupRelease(data: unknown): string | undefined {
  if (!Array.isArray(data) || data.length > 20) return undefined;
  let newest: string | undefined;
  for (const entry of data) {
    try {
      if (
        !entry ||
        typeof entry !== "object" ||
        entry.draft !== false ||
        typeof entry.prerelease !== "boolean" ||
        typeof entry.published_at !== "string" ||
        !Number.isFinite(Date.parse(entry.published_at)) ||
        typeof entry.tag_name !== "string" ||
        !entry.tag_name.startsWith("mcp-v")
      )
        continue;
      const v = version(entry.tag_name.slice(5));
      if (
        entry.prerelease !== v.includes("-") ||
        !Array.isArray(entry.assets) ||
        entry.assets.length > 100
      )
        continue;
      const base = `https://github.com/askmyparish/flockbot/releases/download/mcp-v${v}/`;
      if (
        !["md", "zip"].every((ext) => {
          const name = `flockbot-setup-${v}-darwin-arm64.${ext}`;
          return entry.assets.some((asset: unknown) => {
            if (!asset || typeof asset !== "object") return false;
            const a = asset as Record<string, unknown>;
            return (
              a.name === name &&
              a.state === "uploaded" &&
              a.browser_download_url === base + name
            );
          });
        })
      )
        continue;
      if (!newest || compareReleaseVersions(v, newest) > 0) newest = v;
    } catch {
      /* Ignore unrelated or malformed release entries. */
    }
  }
  return newest;
}

// This separate cache stores only a check timestamp and a public version. Never
// open browser-v1 or use the connection's database, lock, cookies or identity.
function cacheDatabase(file: string): DatabaseSync {
  const path = resolve(file),
    root = parse(path).root;
  let current = root;
  for (const part of path.slice(root.length).split(sep)) {
    current = join(current, part);
    if (current !== path && !existsSync(current))
      mkdirSync(current, { mode: 0o700 });
    if (!existsSync(current)) continue;
    const info = lstatSync(current);
    if (info.isSymbolicLink() || (current !== path && !info.isDirectory()))
      throw new Error("Unsafe cache");
  }
  const folder = lstatSync(dirname(path));
  if (
    (process.getuid && folder.uid !== process.getuid()) ||
    (process.platform !== "win32" && (folder.mode & 0o077) !== 0)
  )
    throw new Error("Unsafe cache");
  if (!existsSync(path)) closeSync(openSync(path, "wx", 0o600));
  for (const name of [path, `${path}-journal`, `${path}-wal`, `${path}-shm`]) {
    if (!existsSync(name)) continue;
    const info = lstatSync(name);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.nlink !== 1 ||
      (process.getuid && info.uid !== process.getuid()) ||
      (process.platform !== "win32" && (info.mode & 0o077) !== 0)
    )
      throw new Error("Unsafe cache");
  }
  const db = new DatabaseSync(path, { timeout: 0 });
  try {
    db.exec(
      "CREATE TABLE IF NOT EXISTS update_check (id INTEGER PRIMARY KEY CHECK (id = 1), checked INTEGER NOT NULL, latest TEXT)",
    );
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export interface UpdateNotice {
  installedVersion: string;
  availableVersion: string;
  prerelease: boolean;
  guideUrl: string;
  message: string;
}
export interface UpdateNotifications {
  touch(): void;
  notice(): UpdateNotice | undefined;
  close(): void;
}

export class UpdateChecker implements UpdateNotifications {
  readonly #file: string;
  readonly #installed: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #timeout: number;
  readonly #supported: boolean;
  #latest: string | undefined;
  #job: Promise<void> | undefined;
  #scheduled: NodeJS.Immediate | undefined;
  #controller: AbortController | undefined;
  #closed = false;

  constructor(
    options: {
      file?: string;
      installedVersion?: string;
      fetch?: typeof fetch;
      now?: () => number;
      timeoutMs?: number;
      supported?: boolean;
    } = {},
  ) {
    this.#file =
      options.file ??
      join(connectionProfileDirectory(), "updates-v1", "checks.sqlite");
    this.#installed = version(options.installedVersion ?? MCP_VERSION);
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? Date.now;
    this.#timeout = options.timeoutMs ?? 5000;
    if (!(this.#timeout > 0 && this.#timeout <= 5000))
      throw new Error("Invalid timeout");
    this.#supported =
      process.env.FLOCKBOT_UPDATE_CHECKS !== "0" &&
      (options.supported ??
        (process.platform === "darwin" && process.arch === "arm64"));
  }

  touch(): void {
    if (this.#closed || this.#scheduled || this.#job || !this.#supported)
      return;
    this.#scheduled = setImmediate(() => {
      this.#scheduled = undefined;
      void this.refresh();
    });
    this.#scheduled.unref();
  }

  notice(): UpdateNotice | undefined {
    if (
      !this.#latest ||
      compareReleaseVersions(this.#latest, this.#installed) <= 0
    )
      return;
    return {
      installedVersion: this.#installed,
      availableVersion: this.#latest,
      prerelease: this.#latest.includes("-"),
      guideUrl: UPDATE_GUIDE,
      message:
        "A Flockbot update is available. Say “Update Flockbot” to install it.",
    };
  }

  /** Awaited only by offline tests. Tool handlers use touch and cached notice. */
  refresh(): Promise<void> {
    if (this.#closed || !this.#supported) return Promise.resolve();
    if (this.#job) return this.#job;
    this.#job = this.#refresh()
      .catch(() => undefined)
      .finally(() => {
        this.#job = undefined;
      });
    return this.#job;
  }

  async #refresh(): Promise<void> {
    const now = this.#now();
    let db: DatabaseSync | undefined;
    try {
      db = cacheDatabase(this.#file);
      db.exec("BEGIN IMMEDIATE");
      const saved = db
        .prepare("SELECT checked, latest FROM update_check WHERE id = 1")
        .get();
      this.#latest = undefined;
      if (saved) {
        if (!Number.isSafeInteger(saved.checked) || Number(saved.checked) < 0)
          throw new Error("Invalid cache");
        if (saved.latest !== null) this.#latest = version(saved.latest);
        // A backward clock change waits for time to catch up, never a request storm.
        if (now - Number(saved.checked) < DAY) {
          db.exec("COMMIT");
          return;
        }
      }
      // Commit the attempt BEFORE network. All processes share this atomic claim;
      // crashes and failed checks consume the daily budget too. Busy means skip.
      db.prepare(
        "INSERT INTO update_check VALUES (1, ?, NULL) ON CONFLICT(id) DO UPDATE SET checked=excluded.checked, latest=NULL",
      ).run(now);
      db.exec("COMMIT");
      db.close();
      db = undefined;
      this.#latest = undefined;
      const controller = new AbortController();
      this.#controller = controller;
      let timer: NodeJS.Timeout | undefined;
      try {
        const expiry = new Promise<never>((_, reject) => {
          controller.signal.addEventListener(
            "abort",
            () => reject(new Error("Update check stopped")),
            { once: true },
          );
          timer = setTimeout(() => controller.abort(), this.#timeout);
          timer.unref();
        });
        const request = async () => {
          const response = await this.#fetch(RELEASES_URL, {
            signal: controller.signal,
            redirect: "error",
            credentials: "omit",
            headers: {
              Accept: "application/vnd.github+json",
              "User-Agent": "AskMyParish-Flockbot",
            },
          });
          if (controller.signal.aborted || !response.ok || !response.body)
            throw new Error("No release metadata");
          const reader = response.body.getReader();
          const cancel = () => {
            void reader.cancel().catch(() => undefined);
          };
          controller.signal.addEventListener("abort", cancel, { once: true });
          let size = 0,
            text = "";
          const decoder = new TextDecoder("utf-8", { fatal: true });
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (controller.signal.aborted)
                throw new Error("Update check stopped");
              if (done) break;
              size += value.byteLength;
              if (size > MAX_BODY)
                throw new Error("Release metadata too large");
              text += decoder.decode(value, { stream: true });
            }
            text += decoder.decode();
            return newestSetupRelease(JSON.parse(text));
          } finally {
            controller.signal.removeEventListener("abort", cancel);
            cancel();
          }
        };
        const latest = await Promise.race([request(), expiry]);
        if (!this.#closed) {
          db = cacheDatabase(this.#file);
          db.prepare(
            "UPDATE update_check SET latest=? WHERE id=1 AND checked=?",
          ).run(latest ?? null, now);
          this.#latest = latest;
        }
      } finally {
        if (timer) clearTimeout(timer);
        this.#controller = undefined;
      }
    } finally {
      db?.close();
    }
  }

  close(): void {
    this.#closed = true;
    if (this.#scheduled) clearImmediate(this.#scheduled);
    this.#controller?.abort();
  }
}
