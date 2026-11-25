import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  accessSync,
  chmodSync,
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse as parseToml } from "smol-toml";

// Adds one `flockbot` server entry to each assistant's own configuration,
// leaving every other setting in those files alone. The setup apps call these
// through the connector's `assistants`, `connect`, `disconnect` and `repoint`
// commands, so every platform shares one implementation.

export const assistants = ["claude-desktop", "claude-code", "codex"] as const;
export type Assistant = (typeof assistants)[number];

export function isAssistant(value: unknown): value is Assistant {
  return assistants.includes(value as Assistant);
}

/** Whose settings to change, and the connector their entries should run. */
export interface Setup {
  /** This connector's own path; each assistant launches it by that path. */
  readonly command: string;
  readonly home: string;
  readonly environment: NodeJS.ProcessEnv;
  /** Whose file layout to use. Paths are still built for the running OS. */
  readonly platform: NodeJS.Platform;
  /**
   * Whether Claude Desktop is open, or undefined when that can't be told;
   * see `claudeDesktopRunning`.
   */
  readonly claudeDesktopOpen: () => boolean | undefined;
}

/** A failure whose message can be shown to the person as it is. */
export class SetupError extends Error {}

export function setupMessage(error: unknown): string {
  if (error instanceof SetupError) return error.message;
  const detail = error instanceof Error ? ` ${error.message}` : "";
  return `Flockbot couldn't change this assistant's settings.${detail}`;
}

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

const usage = "<claude-desktop|claude-code|codex>";

/**
 * The connector's `assistants`, `connect <name>`, `disconnect <name>` and
 * `repoint` commands. Each replies on stdout with one JSON object; a change
 * that fails replies `{"error": "<message to show>"}` rather than exiting
 * with an error, and a change that succeeds replies `{"changed": true}`.
 */
export function runAssistantCommand(
  args: readonly string[],
  setup: Setup,
): CommandResult {
  const json = (value: unknown) => ({
    stdout: `${JSON.stringify(value)}\n`,
    stderr: "",
    exitCode: 0,
  });
  const [command, name] = args;
  if (command === "assistants") return json(assistantStates(setup));
  if (command === "repoint") return json({ results: repointMoved(setup) });
  if ((command !== "connect" && command !== "disconnect") || !isAssistant(name))
    return {
      stdout: "",
      stderr: `Usage: flockbot-mcp ${command === "disconnect" ? "disconnect" : "connect"} ${usage}\n`,
      exitCode: 2,
    };
  try {
    (command === "connect" ? connect : disconnect)(setup, name);
    return json({ changed: true });
  } catch (error) {
    return json({ error: setupMessage(error) });
  }
}

export interface AssistantState {
  readonly connected: boolean;
  /** Whether the assistant's command-line tool is installed. */
  readonly commandLine: boolean;
}

const server = "flockbot";
type Json = Record<string, unknown>;

function paths(setup: Setup) {
  const codexHome = setup.environment.CODEX_HOME;
  const shared = {
    claudeCode: join(setup.home, ".claude.json"),
    codex: join(
      codexHome ? codexHome : join(setup.home, ".codex"),
      "config.toml",
    ),
  };
  if (setup.platform === "win32") {
    const { local, roaming } = windowsAppData(setup);
    return {
      ...shared,
      claudeDesktop: join(
        storeClaudeFolder(local) ?? join(roaming, "Claude"),
        "claude_desktop_config.json",
      ),
      // Not %LOCALAPPDATA%\Flockbot: the installer replaces that folder.
      claudeCodeBackup: join(local, "Flockbot MCP", "claude-code-entry.json"),
    };
  }
  const support = join(setup.home, "Library", "Application Support");
  return {
    ...shared,
    claudeDesktop: join(support, "Claude", "claude_desktop_config.json"),
    claudeCodeBackup: join(support, "flockbot", "claude-code-entry.json"),
  };
}

function windowsAppData(setup: Setup): { local: string; roaming: string } {
  const { LOCALAPPDATA, APPDATA } = setup.environment;
  return {
    local: LOCALAPPDATA || join(setup.home, "AppData", "Local"),
    roaming: APPDATA || join(setup.home, "AppData", "Roaming"),
  };
}

/**
 * Claude Desktop from the Microsoft Store keeps its settings in
 * %LOCALAPPDATA%\Claude-Data\claude_<publisher id>, named after its package,
 * rather than in %APPDATA%\Claude like other installs. A folder that already
 * holds settings wins over an empty one.
 */
function storeClaudeFolder(local: string): string | undefined {
  const parent = join(local, "Claude-Data");
  let folders: string[];
  try {
    folders = readdirSync(parent, { withFileTypes: true })
      .filter(
        (entry) => entry.isDirectory() && /^claude_\w+$/i.test(entry.name),
      )
      .map((entry) => join(parent, entry.name))
      .sort();
  } catch {
    return undefined;
  }
  return (
    folders.find((folder) =>
      existsSync(join(folder, "claude_desktop_config.json")),
    ) ?? folders[0]
  );
}

/** Windows paths ignore case; so does the default Mac file system. */
function samePath(setup: Setup, a: string | undefined): boolean {
  if (a === undefined) return false;
  return setup.platform === "win32"
    ? a.toLowerCase() === setup.command.toLowerCase()
    : a === setup.command;
}

/** Whether a command is a Flockbot connector, wherever it was installed. */
function isConnector(command: string): boolean {
  return /^flockbot-mcp(\.exe)?$/i.test(command.split(/[\\/]/).pop() ?? "");
}

export function assistantStates(
  setup: Setup,
): Record<Assistant, AssistantState> {
  return {
    "claude-desktop": {
      connected: samePath(setup, registeredCommand(setup, "claude-desktop")),
      commandLine: false,
    },
    "claude-code": {
      connected: samePath(setup, registeredCommand(setup, "claude-code")),
      commandLine: claudeCLI(setup) !== undefined,
    },
    codex: {
      connected: codexConnected(setup),
      commandLine: codexCLI(setup) !== undefined,
    },
  };
}

/** The command the assistant's `flockbot` entry runs, if it has one. */
export function registeredCommand(
  setup: Setup,
  assistant: Assistant,
): string | undefined {
  const files = paths(setup);
  switch (assistant) {
    case "claude-desktop":
      return jsonCommand(files.claudeDesktop);
    case "claude-code":
      return jsonCommand(files.claudeCode);
    case "codex":
      return codexCommand(setup);
  }
}

export function connect(setup: Setup, assistant: Assistant): void {
  const files = paths(setup);
  switch (assistant) {
    case "claude-desktop": {
      const path = resolved(files.claudeDesktop);
      const root = readJSON(path) ?? {};
      root.mcpServers = {
        ...serversIn(root, path),
        [server]: { command: setup.command, args: [] },
      };
      writeClaudeDesktop(setup, path, root, "Connect");
      return;
    }
    case "claude-code": {
      // Claude Code rewrites ~/.claude.json while it runs, so its own CLI
      // makes the change.
      const claude = requireClaude(setup);
      try {
        run(setup, claude, ["mcp", "remove", "--scope", "user", server], "");
      } catch {
        // Nothing to replace.
      }
      run(
        setup,
        claude,
        ["mcp", "add", "--scope", "user", server, "--", setup.command],
        claudeCodeFailed("add"),
      );
      return;
    }
    case "codex":
      connectCodex(setup);
      return;
  }
}

/** Removes only the `flockbot` entry, leaving the rest of each file alone. */
export function disconnect(setup: Setup, assistant: Assistant): void {
  const files = paths(setup);
  switch (assistant) {
    case "claude-desktop": {
      const path = resolved(files.claudeDesktop);
      const root = readJSON(path);
      if (root === undefined) return;
      const servers = serversIn(root, path);
      if (!Object.hasOwn(servers, server)) return;
      root.mcpServers = Object.fromEntries(
        Object.entries(servers).filter(([name]) => name !== server),
      );
      writeClaudeDesktop(setup, path, root, "Disconnect");
      return;
    }
    case "claude-code":
      run(
        setup,
        requireClaude(setup),
        ["mcp", "remove", "--scope", "user", server],
        claudeCodeFailed("remove"),
      );
      return;
    case "codex": {
      const path = resolved(files.codex);
      const text = readText(path);
      if (text === undefined) return;
      const lines = text.split("\n");
      const section = codexSection(lines);
      if (section === undefined) {
        // Status reads the parsed file, so an entry this line editor can't
        // find, such as an inline table, still reads as connected.
        const settings = codexSettings(text);
        if (
          isTable(settings?.mcp_servers) &&
          Object.hasOwn(settings.mcp_servers, server)
        )
          throw codexUnchanged(path);
        return;
      }
      lines.splice(section.start, section.end - section.start);
      writeCodex(
        path,
        text,
        withoutTrailingBlankLines(lines.join("\n")),
        () => undefined,
      );
      return;
    }
  }
}

/**
 * One assistant's takeover: when its change was written, in milliseconds
 * since 1970, or why it failed. Each carries its own time, so an assistant
 * that restarts while a later one is still changing isn't asked to again.
 */
export type RepointResult =
  | { readonly assistant: Assistant; readonly changedAt: number }
  | { readonly assistant: Assistant; readonly error: string };

/**
 * Points entries left behind by a moved or renamed copy of the app at this
 * connector. Entries that run anything other than a Flockbot connector belong
 * to someone else and stay. The caller decides whether this copy is installed
 * somewhere it will stay.
 */
export function repointMoved(setup: Setup): RepointResult[] {
  return assistants.flatMap((assistant): RepointResult[] => {
    // Reading an entry never throws, so one unreadable file can't hide the
    // other assistants' results.
    const command = registeredCommand(setup, assistant);
    if (
      command === undefined ||
      samePath(setup, command) ||
      !isConnector(command)
    )
      return [];
    try {
      repoint(setup, assistant);
      return [{ assistant, changedAt: Date.now() }];
    } catch (error) {
      return [{ assistant, error: setupMessage(error) }];
    }
  });
}

/**
 * Changes only the entry's command, keeping its arguments, environment and
 * any other settings, such as a Codex entry someone disabled.
 */
export function repoint(setup: Setup, assistant: Assistant): void {
  const files = paths(setup);
  switch (assistant) {
    case "claude-desktop": {
      const path = resolved(files.claudeDesktop);
      const root = readJSON(path);
      if (root === undefined) throw unreadable(path);
      const servers = serversIn(root, path);
      const entry = servers[server];
      if (!isObject(entry)) throw unreadable(path);
      root.mcpServers = {
        ...servers,
        [server]: { ...entry, command: setup.command },
      };
      writeClaudeDesktop(setup, path, root, "Connect");
      return;
    }
    case "claude-code": {
      const claude = requireClaude(setup);
      const root = readJSON(files.claudeCode);
      const original =
        root && isObject(root.mcpServers) ? root.mcpServers[server] : undefined;
      if (!isObject(original)) throw unreadable(files.claudeCode);
      const replacement = JSON.stringify({
        ...original,
        command: setup.command,
      });
      const restore = JSON.stringify(original);
      // Claude Code can only replace an entry by removing it first, so keep a
      // copy until the new one is in, in case putting the old one back fails.
      writePrivate(files.claudeCodeBackup, restore);
      const addJSON = ["mcp", "add-json", "--scope", "user", server];
      try {
        run(
          setup,
          claude,
          ["mcp", "remove", "--scope", "user", server],
          claudeCodeFailed("update"),
        );
      } catch (error) {
        removeQuietly(files.claudeCodeBackup);
        throw error;
      }
      try {
        run(
          setup,
          claude,
          [...addJSON, replacement],
          claudeCodeFailed("update"),
        );
      } catch (error) {
        // Put the old entry back rather than leave Claude Code without one.
        try {
          run(setup, claude, [...addJSON, restore], "");
        } catch {
          throw new SetupError(
            `Claude Code lost its Flockbot connection during an update. Click Connect to add it again. Its previous settings are saved in ${files.claudeCodeBackup}.`,
          );
        }
        removeQuietly(files.claudeCodeBackup);
        throw error;
      }
      removeQuietly(files.claudeCodeBackup);
      return;
    }
    case "codex": {
      const path = resolved(files.codex);
      const text = readText(path);
      if (text === undefined) throw unreadable(path);
      const lines = text.split("\n");
      const entry = codexCommandEntry(lines);
      if (entry === undefined) throw unreadable(path);
      const line = lines[entry.line] as string;
      lines[entry.line] =
        line.slice(0, entry.start) +
        tomlString(setup.command) +
        line.slice(entry.end);
      writeCodex(path, text, lines.join("\n"), (current) => ({
        ...(isTable(current) ? current : {}),
        command: setup.command,
      }));
      return;
    }
  }
}

// MARK: Command-line tools

function claudeCLI(setup: Setup): string | undefined {
  // An npm-installed claude.cmd needs a shell to run, and passing the entry's
  // JSON through one isn't safe, so Windows looks only for the native install.
  if (setup.platform === "win32")
    return firstExecutable([join(setup.home, ".local", "bin", "claude.exe")]);
  return firstExecutable([
    join(setup.home, ".local", "bin", "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
    join(setup.home, ".claude", "local", "claude"),
  ]);
}

function codexCLI(setup: Setup): string | undefined {
  // Only reported, never run, so npm's codex.cmd is fine to count.
  if (setup.platform === "win32")
    return firstExecutable([
      join(windowsAppData(setup).roaming, "npm", "codex.cmd"),
    ]);
  return firstExecutable([
    join(setup.home, ".local", "bin", "codex"),
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
  ]);
}

function requireClaude(setup: Setup): string {
  const claude = claudeCLI(setup);
  if (claude === undefined)
    throw new SetupError(
      "Flockbot couldn't find the claude command. Install Claude Code first.",
    );
  return claude;
}

function firstExecutable(candidates: string[]): string | undefined {
  return candidates.find((path) => {
    try {
      accessSync(path, constants.X_OK);
      return statSync(path).isFile();
    } catch {
      return false;
    }
  });
}

/**
 * What to tell the person when Claude Code fails. Its own output stays out of
 * the message: it can repeat the entry it was given, environment and all.
 */
function claudeCodeFailed(action: "add" | "remove" | "update"): string {
  return `Claude Code couldn't ${action} Flockbot's connection. Check that the claude command works in Terminal, then try again.`;
}

/** Runs a command-line tool, throwing `failure` as the message if it fails. */
function run(
  setup: Setup,
  path: string,
  args: string[],
  failure: string,
): void {
  const result = spawnSync(path, args, {
    // Apps opened from the Finder get a minimal PATH. Windows apps get the
    // whole one, and copying it could leave both Path and PATH set.
    env:
      setup.platform === "win32"
        ? setup.environment
        : {
            ...setup.environment,
            PATH: [
              join(setup.home, ".local", "bin"),
              "/opt/homebrew/bin",
              "/usr/local/bin",
              "/usr/bin",
              "/bin",
            ].join(":"),
          },
    // A setup window has no console for the tool to borrow; don't open one.
    windowsHide: true,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
  });
  if (result.error !== undefined || result.status !== 0)
    throw new SetupError(failure);
}

// MARK: Codex

const codexHeader = `[mcp_servers.${server}]`;
// That table's header as Codex may also write it: with spaces, basic or
// literal quoted keys or a trailing comment. And the start of any table
// nested under it.
const codexTable = new RegExp(
  `^\\[\\s*(["']?)mcp_servers\\1\\s*\\.\\s*(["']?)${server}\\2\\s*\\]\\s*(?:#.*)?$`,
);
const codexSubtable = new RegExp(
  `^\\[\\[?\\s*(["']?)mcp_servers\\1\\s*\\.\\s*(["']?)${server}\\2\\s*\\.`,
);

function codexCommandLine(setup: Setup): string {
  return `command = ${tomlString(setup.command)}`;
}

function codexCommand(setup: Setup): string | undefined {
  const text = readForStatus(paths(setup).codex);
  const entry = text === undefined ? undefined : codexSettings(text);
  const servers = isTable(entry?.mcp_servers) ? entry.mcp_servers : {};
  const command = isTable(servers[server])
    ? servers[server].command
    : undefined;
  return typeof command === "string" ? command : undefined;
}

function codexConnected(setup: Setup): boolean {
  return samePath(setup, codexCommand(setup));
}

/**
 * Replaces any existing `[mcp_servers.flockbot]` table, including its
 * subtables, then appends the current one. Other text is kept as written.
 */
function connectCodex(setup: Setup): void {
  const path = resolved(paths(setup).codex);
  const text = readText(path) ?? "";
  const lines = text.split("\n");
  const section = codexSection(lines);
  if (section !== undefined)
    lines.splice(section.start, section.end - section.start);
  let result = withoutTrailingBlankLines(lines.join("\n"));
  if (result !== "") result += result.endsWith("\n") ? "\n" : "\n\n";
  writeCodex(
    path,
    text,
    `${result}${codexHeader}\n${codexCommandLine(setup)}\n`,
    () => ({ command: setup.command }),
  );
}

/**
 * Codex's settings as plain JSON values, or undefined when the text isn't
 * valid TOML. The parser's own tables and dates don't compare as plain ones.
 */
function codexSettings(text: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(JSON.stringify(parseToml(text.replace(/^\uFEFF/, ""))));
  } catch {
    return undefined;
  }
}

function isTable(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The settings without the `flockbot` server, or an `mcp_servers` it emptied. */
function withoutFlockbot(
  settings: Record<string, unknown>,
): Record<string, unknown> {
  if (!isTable(settings.mcp_servers)) return settings;
  const { [server]: _removed, ...servers } = settings.mcp_servers;
  const { mcp_servers: _all, ...rest } = settings;
  return Object.keys(servers).length > 0
    ? { ...rest, mcp_servers: servers }
    : rest;
}

/**
 * The Codex edits above work line by line to keep comments and layout, so
 * each result is parsed before it's written. It's written only when the
 * `flockbot` server is what `expected` makes of the old one and nothing else
 * changed; otherwise the file stays as it was.
 */
function writeCodex(
  path: string,
  before: string,
  after: string,
  expected: (current: unknown) => unknown,
): void {
  const old = codexSettings(before);
  const next = codexSettings(after);
  const servers = (settings: Record<string, unknown> | undefined) =>
    isTable(settings?.mcp_servers) ? settings.mcp_servers : {};
  if (
    old === undefined ||
    next === undefined ||
    !isDeepStrictEqual(withoutFlockbot(old), withoutFlockbot(next)) ||
    !isDeepStrictEqual(servers(next)[server], expected(servers(old)[server]))
  )
    throw codexUnchanged(path);
  writePrivate(path, after);
}

function codexUnchanged(path: string): SetupError {
  return new SetupError(
    `Flockbot couldn't change ${path} safely, so it left the file unchanged.`,
  );
}

/** The `[mcp_servers.flockbot]` table and its subtables, as a line range. */
function codexSection(
  lines: string[],
): { start: number; end: number } | undefined {
  const start = lines.findIndex((line) => codexTable.test(line.trim()));
  if (start < 0) return undefined;
  let end = start + 1;
  while (end < lines.length) {
    const line = (lines[end] as string).trim();
    if (line.startsWith("[") && !codexSubtable.test(line)) break;
    end += 1;
  }
  return { start, end };
}

/**
 * The `command` key of the `[mcp_servers.flockbot]` table itself, not of a
 * subtable: its line, the range of its string value and the decoded value.
 */
function codexCommandEntry(
  lines: string[],
): { line: number; start: number; end: number; value: string } | undefined {
  const section = codexSection(lines);
  if (section === undefined) return undefined;
  let tableEnd = section.start + 1;
  while (
    tableEnd < section.end &&
    !(lines[tableEnd] as string).trim().startsWith("[")
  )
    tableEnd += 1;
  const table = lines.slice(section.start + 1, tableEnd);
  // A line inside a multi-line string can look like a key. Rather than track
  // that context, a table with one is never read, so it's never rewritten.
  if (table.some((line) => line.includes('"""') || line.includes("'''")))
    return undefined;
  for (const [offset, line] of table.entries()) {
    const equals = line.indexOf("=");
    if (equals < 0 || line.slice(0, equals).trim() !== "command") continue;
    const string = tomlStringAt(line, equals);
    if (string !== undefined)
      return { line: section.start + 1 + offset, ...string };
  }
  return undefined;
}

const escapes: Readonly<Record<string, string>> = {
  '"': '"',
  "\\": "\\",
  b: "\b",
  t: "\t",
  n: "\n",
  f: "\f",
  r: "\r",
};

/**
 * Reads the single-line basic ("…") or literal ('…') TOML string after `=`,
 * followed by nothing but whitespace or a comment. Anything else, including
 * multi-line strings and unknown escapes, returns undefined so the entry is
 * left alone.
 */
function tomlStringAt(
  line: string,
  equals: number,
): { start: number; end: number; value: string } | undefined {
  let index = equals + 1;
  while (line[index] === " " || line[index] === "\t") index += 1;
  const quote = line[index];
  if (quote !== '"' && quote !== "'") return undefined;
  const start = index;
  if (line.startsWith(quote.repeat(2), start + 1)) return undefined;
  let value = "";
  index = start + 1;
  for (;;) {
    const character = line[index];
    if (character === undefined) return undefined;
    if (character === quote) break;
    if (quote === '"' && character === "\\") {
      index += 1;
      const escaped = line[index];
      if (escaped === "u" || escaped === "U") {
        const length = escaped === "u" ? 4 : 8;
        const digits = line.slice(index + 1, index + 1 + length);
        if (digits.length !== length || !/^[0-9a-fA-F]+$/.test(digits))
          return undefined;
        const code = Number.parseInt(digits, 16);
        if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff))
          return undefined;
        value += String.fromCodePoint(code);
        index += length;
      } else {
        const decoded = escaped === undefined ? undefined : escapes[escaped];
        if (decoded === undefined) return undefined;
        value += decoded;
      }
    } else {
      value += character;
    }
    index += 1;
  }
  const end = index + 1;
  const rest = line.slice(end).trim();
  if (rest !== "" && !rest.startsWith("#")) return undefined;
  return { start, end, value };
}

function tomlString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

// MARK: Files

// Source text access in JSON.parse and JSON.rawJSON (Node 21+, Bun) are newer
// than the ES2022 types this package compiles against.
const exactJSON = JSON as JSON & {
  parse(
    text: string,
    reviver: (
      key: string,
      value: unknown,
      context?: { source?: string },
    ) => unknown,
  ): unknown;
  rawJSON(text: string): unknown;
  isRawJSON(value: unknown): boolean;
};

function isObject(value: unknown): value is Json {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !exactJSON.isRawJSON(value)
  );
}

function unreadable(path: string): SetupError {
  return new SetupError(
    `Flockbot couldn't read ${path}, so it left the file unchanged.`,
  );
}

// Fails on bytes that aren't UTF-8 rather than replacing them, so a file
// that isn't text is never rewritten. A byte order mark is kept as written.
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** The file's text, or undefined when it doesn't exist. */
function readText(path: string): string | undefined {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw unreadable(path);
  }
  try {
    return utf8.decode(bytes);
  } catch {
    throw unreadable(path);
  }
}

/** Status treats a file it can't read as having no entry. */
function readForStatus(path: string): string | undefined {
  try {
    return readText(path);
  } catch {
    return undefined;
  }
}

/** Cleanup that must not change the outcome of the change it follows. */
function removeQuietly(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // A leftover backup is harmless; the next update replaces it.
  }
}

/** A JSON object file, or undefined when it doesn't exist. */
function readJSON(path: string): Json | undefined {
  const text = readText(path);
  if (text === undefined) return undefined;
  let value: unknown;
  try {
    // A byte order mark is valid in these files but not in JSON.parse. Numbers
    // keep their exact text, so rewriting a file can't round an integer past
    // 2^53 or reformat any other number someone wrote.
    value = exactJSON.parse(
      text.replace(/^\uFEFF/, ""),
      (_key: string, parsed: unknown, context?: { source?: string }) =>
        typeof parsed === "number" &&
        context?.source !== undefined &&
        JSON.stringify(parsed) !== context.source
          ? exactJSON.rawJSON(context.source)
          : parsed,
    );
  } catch {
    throw unreadable(path);
  }
  if (!isObject(value)) throw unreadable(path);
  return value;
}

function jsonCommand(path: string): string | undefined {
  try {
    const root = readJSON(path);
    const servers = root?.mcpServers;
    const entry = isObject(servers) ? servers[server] : undefined;
    return isObject(entry) && typeof entry.command === "string"
      ? entry.command
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The file's server list. Anything but a JSON object there is a file this
 * connector doesn't understand, so it refuses to replace it.
 */
function serversIn(root: Json, path: string): Json {
  const servers = root.mcpServers;
  if (servers === undefined) return {};
  if (!isObject(servers)) throw unreadable(path);
  return servers;
}

/**
 * Follows a symlinked dotfile so it is updated in place rather than replaced,
 * including a link to a file that doesn't exist yet.
 */
function resolved(path: string, links = 0): string {
  try {
    return realpathSync(path);
  } catch {
    // Missing, or a link whose target is missing.
  }
  let target: string;
  try {
    target = readlinkSync(path);
  } catch {
    return path;
  }
  // The same limit macOS puts on following links.
  if (links >= 32) throw unreadable(path);
  return resolved(resolve(dirname(path), target), links + 1);
}

function withoutTrailingBlankLines(text: string): string {
  let result = text;
  while (result.endsWith("\n\n")) result = result.slice(0, -1);
  return result;
}

function writeJSON(path: string, root: Json): void {
  writePrivate(path, `${JSON.stringify(root, null, 2)}\n`);
}

/**
 * Claude Desktop keeps its settings file in memory and saves that copy over
 * the file when its own preferences change, dropping an entry added while it
 * was open. So its file changes only while it's known to be closed. `button`
 * names the button that tries again.
 */
function writeClaudeDesktop(
  setup: Setup,
  path: string,
  root: Json,
  button: "Connect" | "Disconnect",
): void {
  const open = setup.claudeDesktopOpen();
  if (open === undefined)
    throw new SetupError(
      `Flockbot couldn't check whether Claude is open, so it left Claude's settings unchanged. Click ${button} to try again.`,
    );
  if (open)
    throw new SetupError(
      setup.platform === "win32"
        ? `Claude is open and would undo this change. Right-click Claude's icon under the ^ arrow next to the clock and choose Quit Claude, then click ${button} again.`
        : `Claude is open and would undo this change. Quit Claude (Claude > Quit Claude), then click ${button} again.`,
    );
  writeJSON(path, root);
}

/**
 * Removes every assistant's entry as Flockbot is uninstalled, so none is left
 * starting a connector that's gone. Nobody is there to quit Claude, so its
 * file changes even while it's open; Claude may write the entry back.
 */
export function disconnectForUninstall(
  setup: Setup,
): { readonly assistant: Assistant; readonly error?: string }[] {
  const anyway: Setup = { ...setup, claudeDesktopOpen: () => false };
  // The file edits first: Claude Code's CLI can be slow, and the uninstaller
  // stops this command when its time is up.
  const order: Assistant[] = ["claude-desktop", "codex", "claude-code"];
  return order.map((assistant) => {
    try {
      disconnect(anyway, assistant);
      return { assistant };
    } catch (error) {
      return { assistant, error: setupMessage(error) };
    }
  });
}

/** Stands in for a running claude whose path couldn't be read. */
const unreadablePath = "?";

/**
 * Whether Claude Desktop's main app is running: true or false, or undefined
 * when the process list can't be read. See `claudeDesktopListed`.
 */
export function claudeDesktopRunning(
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
): boolean | undefined {
  const list =
    platform === "win32"
      ? spawnSync(
          join(
            environment.SystemRoot || "C:\\Windows",
            "System32",
            "WindowsPowerShell",
            "v1.0",
            "powershell.exe",
          ),
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            // Filtered by name rather than `Get-Process -Name claude`, which
            // exits 1 when none is running. A process whose path Windows
            // won't give prints a line of its own, so it can't pass as
            // Claude being closed.
            `Get-Process | Where-Object ProcessName -eq 'claude' | ForEach-Object { if ($_.Path) { $_.Path } else { '${unreadablePath}' } }`,
          ],
          { encoding: "utf8", windowsHide: true, timeout: 15_000 },
        )
      : spawnSync("/bin/ps", ["-axo", "comm="], {
          encoding: "utf8",
          timeout: 15_000,
        });
  if (
    list.error !== undefined ||
    list.status !== 0 ||
    typeof list.stdout !== "string"
  )
    return undefined;
  return claudeDesktopListed(platform, list.stdout);
}

/**
 * Whether a process list, one path per line, shows Claude Desktop's main app
 * running: true or false, or undefined when a claude process's path couldn't
 * be read. Claude Code is also named claude, so it's told apart by where it's
 * installed: on Windows, the Store package or the standalone installer's
 * folder; on a Mac, the main executable of a Claude.app bundle anywhere.
 */
export function claudeDesktopListed(
  platform: NodeJS.Platform,
  processes: string,
): boolean | undefined {
  const desktop =
    platform === "win32"
      ? /\\(WindowsApps\\Claude_[^\\]+|AnthropicClaude)\\/i
      : /\/Claude\.app\/Contents\/MacOS\/Claude$/;
  const lines = processes.split(/\r?\n/).map((line) => line.trim());
  if (lines.some((line) => desktop.test(line))) return true;
  return lines.includes(unreadablePath) ? undefined : false;
}

/**
 * Atomic owner-only write. The temporary file gets an unguessable name and
 * must be new, so the write can't follow a link someone left in its place.
 */
function writePrivate(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.flockbot-tmp`;
  let created = false;
  try {
    const file = openSync(temporary, "wx", 0o600);
    // Owned from here, so a write that fails partway is cleaned up too.
    created = true;
    try {
      writeFileSync(file, text);
    } finally {
      closeSync(file);
    }
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } catch (error) {
    if (created) removeQuietly(temporary);
    throw error;
  }
}
