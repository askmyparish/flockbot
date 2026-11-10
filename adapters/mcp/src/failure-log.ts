import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
  type Stats,
} from "node:fs";
import { join, parse, resolve, sep } from "node:path";
import { safeLogRecord } from "./diagnostics.js";
import { ProcessLock } from "./process-lock.js";
import { connectionProfileDirectory } from "./profile.js";
import { runCommand } from "./dpapi.js";

const FILE_BYTES = 1024 * 1024;
const RECORD_BYTES = 16 * 1024;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const names = ["failures.jsonl", "failures.1.jsonl", "writer.sqlite"] as const;

function info(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function privateEntry(entry: Stats): void {
  if (
    (process.getuid && entry.uid !== process.getuid()) ||
    (process.platform !== "win32" && (entry.mode & 0o077) !== 0)
  )
    throw new Error("Diagnostic storage unavailable");
}

function regular(entry: Stats): void {
  privateEntry(entry);
  if (!entry.isFile() || entry.nlink !== 1)
    throw new Error("Diagnostic storage unavailable");
}

async function prepare(directory: string): Promise<void> {
  const root = parse(directory).root;
  let current = root;
  let created = false;
  for (const part of directory.slice(root.length).split(sep)) {
    current = join(current, part);
    let entry = info(current);
    if (!entry) {
      try {
        mkdirSync(current, { mode: 0o700 });
        created = current === directory;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      entry = lstatSync(current);
    }
    if (!entry.isDirectory() || entry.isSymbolicLink())
      throw new Error("Diagnostic storage unavailable");
  }
  privateEntry(lstatSync(directory));
  for (const name of [
    ...names,
    "writer.sqlite-journal",
    "writer.sqlite-wal",
    "writer.sqlite-shm",
  ]) {
    const entry = info(join(directory, name));
    if (entry) regular(entry);
  }
  if (process.platform === "win32") {
    // Node mode bits do not establish Windows privacy. Protect a new directory,
    // and refuse existing ACLs granting anyone other than this OS user access.
    // The path goes only over private stdin; never through a shell interpolation.
    const script = [
      "$ErrorActionPreference='Stop'",
      "$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd()))",
      "$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User",
      ...(created
        ? [
            "$acl=New-Object Security.AccessControl.DirectorySecurity",
            "$acl.SetOwner($sid)",
            "$acl.SetAccessRuleProtection($true,$false)",
            "$rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')",
            "$acl.AddAccessRule($rule)",
            "Set-Acl -LiteralPath $p -AclObject $acl",
          ]
        : []),
      "$paths=@($p)+@(Get-ChildItem -LiteralPath $p -Force | ForEach-Object {$_.FullName})",
      "foreach($path in $paths){",
      "$item=Get-Item -LiteralPath $path -Force",
      "if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){exit 1}",
      "$acl=Get-Acl -LiteralPath $path",
      "if($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value){exit 1}",
      "foreach($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){",
      "if($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -ne $sid.Value){exit 1}",
      "}",
      "}",
    ].join("; ");
    const result = await runCommand(
      `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      Buffer.from(directory).toString("base64"),
    );
    if (result.status !== 0) throw new Error("Diagnostic storage unavailable");
  }
}

/** Open without following links, then validate the actual descriptor before I/O. */
function file(path: string): number {
  const previous = info(path);
  if (previous) regular(previous);
  const fd = openSync(
    path,
    constants.O_RDWR | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    const actual = fstatSync(fd);
    regular(actual);
    if (
      previous &&
      (previous.dev !== actual.dev || previous.ino !== actual.ino)
    )
      throw new Error("Diagnostic storage unavailable");
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function retained(fd: number, now: number): { text: string; changed: boolean } {
  // A malformed oversized file cannot cause an unbounded read or survive repair.
  if (fstatSync(fd).size > FILE_BYTES) return { text: "", changed: true };
  const text = readFileSync(fd, "utf8");
  const lines = text.split("\n");
  lines.pop(); // A partial trailing record is never accepted, even if valid JSON.
  let kept = lines
    .flatMap((line) => {
      try {
        if (Buffer.byteLength(line) > RECORD_BYTES) return [];
        const record = safeLogRecord(JSON.parse(line));
        if (!record) return [];
        const time = Date.parse(record.observedAt);
        if (!Number.isFinite(time) || time < now - RETENTION_MS || time > now)
          return [];
        return [JSON.stringify(record) + "\n"];
      } catch {
        return [];
      }
    })
    .join("");
  // Canonical number/string encoding can be longer than the input JSON.
  while (Buffer.byteLength(kept) > FILE_BYTES)
    kept = kept.slice(kept.indexOf("\n") + 1);
  return { text: kept, changed: kept !== text };
}

function write(fd: number, text: string, append = false): void {
  const start = append ? fstatSync(fd).size : 0;
  if (!append) ftruncateSync(fd, 0);
  // Positional writes avoid readFileSync's advanced descriptor position.
  const bytes = Buffer.from(text);
  let offset = 0;
  while (offset < bytes.length) {
    const count = writeSync(
      fd,
      bytes,
      offset,
      bytes.length - offset,
      start + offset,
    );
    if (count === 0) throw new Error("Diagnostic storage unavailable");
    offset += count;
  }
  fsyncSync(fd);
}

/** Bounded support records; payloads require per-call opt-in, never auth storage. */
export class FailureLog {
  readonly #directory: string;
  readonly #now: () => number;

  constructor(options: { directory?: string; now?: () => number } = {}) {
    this.#directory = resolve(
      options.directory ?? join(connectionProfileDirectory(), "diagnostics-v2"),
    );
    this.#now = options.now ?? Date.now;
  }

  async save(value: unknown, signal?: AbortSignal): Promise<boolean> {
    try {
      const safe = safeLogRecord(value);
      if (!safe) return false;
      const time = Date.parse(safe.observedAt);
      const now = this.#now();
      if (!Number.isFinite(time) || time < now - RETENTION_MS || time > now)
        return false;
      if (safe.version === 2 && safe.diagnostic)
        safe.diagnostic.traceSaved = true;
      const line = JSON.stringify({ ...safe, traceSaved: true }) + "\n";
      return (await this.#access(line, signal)) !== undefined;
    } catch {
      return false;
    }
  }

  /** Supported fixed-location access prunes before returning safe JSON lines. */
  async read(): Promise<string | undefined> {
    try {
      return await this.#access();
    } catch {
      return undefined;
    }
  }

  async #access(line?: string, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    await prepare(this.#directory);
    signal?.throwIfAborted();
    const lockPath = join(this.#directory, "writer.sqlite");
    const lockFd = file(lockPath);
    try {
      if (fstatSync(lockFd).size > 64 * 1024)
        throw new Error("Diagnostic storage unavailable");
    } finally {
      closeSync(lockFd);
    }
    return new ProcessLock(lockPath).runExclusive(
      "diagnostics",
      AbortSignal.any([AbortSignal.timeout(1000), ...(signal ? [signal] : [])]),
      async () => {
        signal?.throwIfAborted();
        const current = file(join(this.#directory, names[0]));
        try {
          const rotated = file(join(this.#directory, names[1]));
          try {
            const now = this.#now();
            const active = retained(current, now);
            const previous = retained(rotated, now);
            if (
              line &&
              Buffer.byteLength(active.text) + Buffer.byteLength(line) >
                FILE_BYTES
            ) {
              // Commit the retained current file before replacing it. No third
              // log copy can temporarily exceed the two-file storage bound.
              write(rotated, active.text);
              write(current, line);
              return active.text + line;
            }
            if (previous.changed) write(rotated, previous.text);
            if (active.changed) write(current, active.text + (line ?? ""));
            else if (line) write(current, line, true);
            return previous.text + active.text + (line ?? "");
          } finally {
            closeSync(rotated);
          }
        } finally {
          closeSync(current);
        }
      },
    );
  }
}
