import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assistantStates,
  connect,
  disconnect,
  registeredCommand,
  repoint,
  repointMoved,
  runAssistantCommand,
  type Setup,
  SetupError,
} from "../../adapters/mcp/src/assistants.js";

const command = "/Applications/Flockbot.app/Contents/MacOS/flockbot-mcp";
const asRoot = process.getuid?.() === 0;
const moved =
  "/Users/someone/Downloads/Flockbot.app/Contents/MacOS/flockbot-mcp";
const otherServer = { command: "/usr/local/bin/other", args: ["--flag"] };
const originalClaudeCodeEntry = {
  type: "stdio",
  command: "/old/Flockbot.app/Contents/MacOS/flockbot-mcp",
  env: { TOKEN: "fictional-secret-1234" },
};

// Each test gets its own home, so real assistant settings are never touched.
let home: string;
let setup: Setup;
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "flockbot-assistants-")));
  setup = { command, home, environment: {} };
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const claudeDesktop = () =>
  join(home, "Library/Application Support/Claude/claude_desktop_config.json");
const claudeCode = () => join(home, ".claude.json");
const claudeCodeBackup = () =>
  join(home, "Library/Application Support/flockbot/claude-code-entry.json");
const codex = () => join(home, ".codex/config.toml");

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}
const read = (path: string) => readFileSync(path, "utf8");
const writeJSON = (path: string, value: unknown) =>
  write(path, JSON.stringify(value));
const readJSON = (path: string) =>
  JSON.parse(read(path)) as Record<string, unknown>;
const permissions = (path: string) => statSync(path).mode & 0o777;
const connected = (assistant: keyof ReturnType<typeof assistantStates>) =>
  assistantStates(setup)[assistant].connected;

/**
 * A stand-in `claude` that records each call, one argument per line. Its
 * first `failedAdds` `add-json` calls fail after echoing their arguments, as
 * a real CLI's diagnostics might. With `lockBackup`, a successful `add-json`
 * makes the backup's folder read-only, so removing the backup fails.
 */
function installFakeClaude(
  failedAdds = 0,
  { lockBackup = false } = {},
): () => string[][] {
  const log = join(home, "claude-calls.log");
  const script = join(home, ".local/bin/claude");
  write(
    script,
    `#!/bin/bash
printf '%s\\n' "$@" >> "${log}"
echo '<end of call>' >> "${log}"
if [[ "$2" == add-json ]]; then
  count_file="${home}/claude-adds"
  count=$(( $(cat "$count_file" 2>/dev/null || echo 0) + 1 ))
  echo "$count" > "$count_file"
  if (( count <= ${failedAdds} )); then echo "add failed: $*" >&2; exit 1; fi
  if ${lockBackup}; then chmod 500 "${dirname(claudeCodeBackup())}"; fi
fi
`,
  );
  chmodSync(script, 0o755);
  return () =>
    existsSync(log)
      ? read(log)
          .split("<end of call>\n")
          .slice(0, -1)
          .map((call) => call.split("\n").slice(0, -1))
      : [];
}

function addedEntry(call: string[] | undefined): unknown {
  expect(call?.slice(0, 5)).toEqual([
    "mcp",
    "add-json",
    "--scope",
    "user",
    "flockbot",
  ]);
  return JSON.parse(call?.at(-1) ?? "");
}

describe("Claude Desktop settings", () => {
  it("connects while keeping other settings and servers, owner-only", () => {
    writeJSON(claudeDesktop(), {
      theme: "dark",
      mcpServers: { other: otherServer },
    });

    connect(setup, "claude-desktop");

    expect(readJSON(claudeDesktop())).toEqual({
      theme: "dark",
      mcpServers: { other: otherServer, flockbot: { command, args: [] } },
    });
    expect(connected("claude-desktop")).toBe(true);
    expect(permissions(claudeDesktop())).toBe(0o600);
  });

  it("keeps numbers exactly as written in other settings", () => {
    write(
      claudeDesktop(),
      '{"limit": 9007199254740993, "ratio": 1.0, "big": 1e400, "mcpServers": {}}',
    );

    connect(setup, "claude-desktop");

    const text = read(claudeDesktop());
    expect(text).toContain('"limit": 9007199254740993');
    expect(text).toContain('"ratio": 1.0');
    expect(text).toContain('"big": 1e400');
    expect(connected("claude-desktop")).toBe(true);
  });

  it("reads and edits a file that starts with a byte order mark", () => {
    write(
      claudeDesktop(),
      `\uFEFF{"mcpServers": {"flockbot": {"command": "${moved}"}}}`,
    );
    expect(registeredCommand(setup, "claude-desktop")).toBe(moved);

    repoint(setup, "claude-desktop");

    expect(connected("claude-desktop")).toBe(true);
  });

  it("creates a missing file", () => {
    connect(setup, "claude-desktop");
    expect(connected("claude-desktop")).toBe(true);
  });

  it("refuses files it cannot parse and leaves them unchanged", () => {
    const invalid = '{ "mcpServers": { // a comment\n';
    write(claudeDesktop(), invalid);
    expect(() => connect(setup, "claude-desktop")).toThrow(SetupError);
    expect(() => disconnect(setup, "claude-desktop")).toThrow(SetupError);
    expect(read(claudeDesktop())).toBe(invalid);

    const listOfServers = '{"mcpServers": ["flockbot"]}';
    write(claudeDesktop(), listOfServers);
    expect(() => connect(setup, "claude-desktop")).toThrow(SetupError);
    expect(read(claudeDesktop())).toBe(listOfServers);
  });

  it("disconnects only Flockbot", () => {
    writeJSON(claudeDesktop(), {
      mcpServers: { other: otherServer, flockbot: { command } },
    });

    disconnect(setup, "claude-desktop");

    expect(readJSON(claudeDesktop())).toEqual({
      mcpServers: { other: otherServer },
    });
    expect(connected("claude-desktop")).toBe(false);
  });

  it("leaves the file alone when there is nothing to disconnect", () => {
    disconnect(setup, "claude-desktop");
    expect(existsSync(claudeDesktop())).toBe(false);

    const text = '{"mcpServers":{"other":{}}}';
    write(claudeDesktop(), text);
    disconnect(setup, "claude-desktop");
    expect(read(claudeDesktop())).toBe(text);
  });

  it("writes through a symlinked config", () => {
    const target = join(home, "dotfiles/claude_desktop_config.json");
    writeJSON(target, { mcpServers: {} });
    mkdirSync(dirname(claudeDesktop()), { recursive: true });
    symlinkSync(target, claudeDesktop());

    connect(setup, "claude-desktop");

    expect(readlinkSync(claudeDesktop())).toBe(target);
    expect(connected("claude-desktop")).toBe(true);
  });

  it("writes through a symlink whose target doesn't exist yet", () => {
    const target = join(home, "dotfiles/codex.toml");
    mkdirSync(dirname(codex()), { recursive: true });
    symlinkSync("../dotfiles/codex.toml", codex());

    connect(setup, "codex");

    expect(readlinkSync(codex())).toBe("../dotfiles/codex.toml");
    expect(read(target)).toContain("[mcp_servers.flockbot]");
    expect(connected("codex")).toBe(true);
  });

  it("refuses a config that is a loop of symlinks", () => {
    mkdirSync(dirname(codex()), { recursive: true });
    symlinkSync("config.toml", codex());

    expect(() => connect(setup, "codex")).toThrow(SetupError);
    expect(readlinkSync(codex())).toBe("config.toml");
  });

  it("repoints only the command", () => {
    writeJSON(claudeDesktop(), {
      mcpServers: {
        flockbot: { command: moved, args: ["--x"], env: { A: "1" } },
      },
    });

    repoint(setup, "claude-desktop");

    expect(readJSON(claudeDesktop())).toEqual({
      mcpServers: { flockbot: { command, args: ["--x"], env: { A: "1" } } },
    });
  });
});

describe("Codex settings", () => {
  it("connects after existing settings, owner-only", () => {
    write(
      codex(),
      'model = "o3"\n\n[mcp_servers.other]\ncommand = "other"\n\n\n',
    );

    connect(setup, "codex");

    expect(read(codex())).toBe(
      `model = "o3"\n\n[mcp_servers.other]\ncommand = "other"\n\n[mcp_servers.flockbot]\ncommand = "${command}"\n`,
    );
    expect(connected("codex")).toBe(true);
    expect(permissions(codex())).toBe(0o600);
  });

  it("replaces the old table and its subtables", () => {
    write(
      codex(),
      '[mcp_servers.flockbot]\ncommand = "/old/flockbot-mcp"\n\n[mcp_servers.flockbot.env]\nA = "1"\n\n[mcp_servers.other]\ncommand = "other"',
    );

    connect(setup, "codex");

    expect(read(codex())).toBe(
      `[mcp_servers.other]\ncommand = "other"\n\n[mcp_servers.flockbot]\ncommand = "${command}"\n`,
    );
  });

  it("honors CODEX_HOME", () => {
    const codexHome = join(home, "elsewhere");
    connect({ ...setup, environment: { CODEX_HOME: codexHome } }, "codex");
    expect(existsSync(join(codexHome, "config.toml"))).toBe(true);
    expect(existsSync(join(home, ".codex"))).toBe(false);
  });

  it("disconnects only Flockbot", () => {
    write(
      codex(),
      'model = "o3"\n\n[mcp_servers.flockbot]\ncommand = "x"\n\n[mcp_servers.flockbot.env]\nA = "1"\n\n[mcp_servers.other]\ncommand = "other"\n\n',
    );

    disconnect(setup, "codex");

    expect(read(codex())).toBe(
      'model = "o3"\n\n[mcp_servers.other]\ncommand = "other"\n',
    );
  });

  it("reads only the table's own command", () => {
    write(
      codex(),
      [
        "[mcp_servers.flockbot.env]",
        'command = "not this one"',
        "",
        "[mcp_servers.flockbot]",
        '# command = "commented out"',
        "args = []",
        "command = 'C:\\literal' # trailing comment",
        "",
        "[mcp_servers.flockbot.extra]",
        'command = "nor this one"',
      ].join("\n"),
    );
    expect(registeredCommand(setup, "codex")).toBe("C:\\literal");
  });

  it("decodes TOML escapes and rejects strings it does not understand", () => {
    const commandIn = (value: string) => {
      write(codex(), `[mcp_servers.flockbot]\ncommand = ${value}\n`);
      return registeredCommand(setup, "codex");
    };
    expect(commandIn(String.raw`"/A\u0020B/\"q\"\\"`)).toBe('/A B/"q"\\');
    expect(commandIn(String.raw`"\U0001F411"`)).toBe("🐑");
    expect(commandIn(String.raw`"\x41"`)).toBeUndefined();
    expect(commandIn(String.raw`"\uD800"`)).toBeUndefined();
    expect(commandIn('"open')).toBeUndefined();
    expect(commandIn('"a" "b"')).toBeUndefined();
    expect(commandIn('"""a"""')).toBeUndefined();
  });

  it("round-trips a path that needs escaping", () => {
    const awkward = { ...setup, command: '/Users/o"neil\\x/flockbot-mcp' };
    connect(awkward, "codex");
    expect(registeredCommand(awkward, "codex")).toBe(awkward.command);
  });

  it("never rewrites a table with a multi-line string", () => {
    const text =
      '[mcp_servers.flockbot]\ncommand = "/old/flockbot-mcp"\ndescription = """\ncommand = "/inside/a/string"\n"""';
    write(codex(), text);

    expect(registeredCommand(setup, "codex")).toBeUndefined();
    expect(() => repoint(setup, "codex")).toThrow(SetupError);
    expect(read(codex())).toBe(text);
  });

  it("leaves a file that isn't UTF-8 byte for byte as it was", () => {
    const bytes = Buffer.concat([
      Buffer.from(
        '[mcp_servers.flockbot]\ncommand = "/old/flockbot-mcp"\nnote = "',
      ),
      Buffer.from([0xff, 0xfe]),
      Buffer.from('"\n'),
    ]);
    mkdirSync(dirname(codex()), { recursive: true });
    writeFileSync(codex(), bytes);

    expect(() => connect(setup, "codex")).toThrow(SetupError);
    expect(() => disconnect(setup, "codex")).toThrow(SetupError);
    expect(() => repoint(setup, "codex")).toThrow(SetupError);
    expect(readFileSync(codex()).equals(bytes)).toBe(true);
  });

  it("still recognizes its own line in a table it cannot read", () => {
    write(
      codex(),
      `[mcp_servers.flockbot]\ncommand = "${command}"\nnote = '''\nx\n'''\n`,
    );
    expect(connected("codex")).toBe(true);
  });

  it("repoints only the string", () => {
    write(
      codex(),
      '[mcp_servers.flockbot]\ncommand   =  "/old/flockbot-mcp"   # moved\nenabled = false',
    );

    repoint(setup, "codex");

    expect(read(codex())).toBe(
      `[mcp_servers.flockbot]\ncommand   =  "${command}"   # moved\nenabled = false`,
    );
  });
});

describe("Claude Code settings", () => {
  const writeEntry = () =>
    writeJSON(claudeCode(), {
      projects: {},
      mcpServers: { flockbot: originalClaudeCodeEntry },
    });

  it("connects through its own CLI and reports the CLI as installed", () => {
    const calls = installFakeClaude();
    expect(assistantStates(setup)["claude-code"].commandLine).toBe(true);

    connect(setup, "claude-code");

    expect(calls()).toEqual([
      ["mcp", "remove", "--scope", "user", "flockbot"],
      ["mcp", "add", "--scope", "user", "flockbot", "--", command],
    ]);
  });

  it("repoints while keeping the rest of the entry", () => {
    const calls = installFakeClaude();
    writeEntry();

    repoint(setup, "claude-code");

    expect(calls().map((call) => call.slice(0, 4))).toEqual([
      ["mcp", "remove", "--scope", "user"],
      ["mcp", "add-json", "--scope", "user"],
    ]);
    expect(addedEntry(calls()[1])).toEqual({
      ...originalClaudeCodeEntry,
      command,
    });
    expect(existsSync(claudeCodeBackup())).toBe(false);
  });

  it("reads an entry after a byte order mark and keeps its numbers exactly", () => {
    const calls = installFakeClaude();
    write(
      claudeCode(),
      `\uFEFF{"mcpServers": {"flockbot": {"command": "${moved}", "timeout": 9007199254740993}}}`,
    );

    repoint(setup, "claude-code");

    expect(calls()[1]?.at(-1)).toBe(
      `{"command":"${command}","timeout":9007199254740993}`,
    );
  });

  it("restores the original entry when adding the new one fails", () => {
    const calls = installFakeClaude(1);
    writeEntry();

    expect(() => repoint(setup, "claude-code")).toThrow(
      "Claude Code couldn't update Flockbot's connection. Check that the claude command works in Terminal, then try again.",
    );

    expect(calls()).toHaveLength(3);
    expect(addedEntry(calls()[2])).toEqual(originalClaudeCodeEntry);
    expect(existsSync(claudeCodeBackup())).toBe(false);
  });

  it("keeps an owner-only backup when the entry is lost", () => {
    installFakeClaude(2);
    writeEntry();

    expect(() => repoint(setup, "claude-code")).toThrow(
      `Its previous settings are saved in ${claudeCodeBackup()}.`,
    );

    expect(readJSON(claudeCodeBackup())).toEqual(originalClaudeCodeEntry);
    expect(permissions(claudeCodeBackup())).toBe(0o600);
  });

  it("keeps Claude Code's own output, which can repeat the entry, out of messages", () => {
    installFakeClaude(1);
    writeEntry();

    const [result] = repointMoved(setup);

    expect(result).toEqual({
      assistant: "claude-code",
      error: expect.stringMatching(/^Claude Code couldn't update/),
    });
    expect(JSON.stringify(result)).not.toContain("fictional-secret-1234");
  });

  // Root ignores the permissions this test relies on.
  it.skipIf(asRoot)(
    "reports a successful update when the backup can't be removed",
    () => {
      installFakeClaude(0, { lockBackup: true });
      writeEntry();
      try {
        expect(() => repoint(setup, "claude-code")).not.toThrow();
        expect(existsSync(claudeCodeBackup())).toBe(true);
      } finally {
        chmodSync(dirname(claudeCodeBackup()), 0o700);
      }
    },
  );

  it.skipIf(
    ["/opt/homebrew/bin/claude", "/usr/local/bin/claude"].some((path) =>
      existsSync(path),
    ),
  )("reports a missing CLI", () => {
    writeEntry();
    expect(() => repoint(setup, "claude-code")).toThrow(
      "Flockbot couldn't find the claude command. Install Claude Code first.",
    );
    expect(assistantStates(setup)["claude-code"].commandLine).toBe(false);
  });
});

describe("a moved app", () => {
  it("takes over only Flockbot connectors, once", () => {
    writeJSON(claudeDesktop(), {
      mcpServers: { flockbot: { command: moved } },
    });
    write(
      codex(),
      '[mcp_servers.flockbot]\ncommand = "/usr/local/bin/someone-elses-server"\n',
    );

    const before = Date.now();
    const results = repointMoved(setup);
    expect(results).toEqual([
      { assistant: "claude-desktop", changedAt: expect.any(Number) },
    ]);
    const changedAt = (results[0] as { changedAt: number }).changedAt;
    expect(changedAt).toBeGreaterThanOrEqual(before);
    expect(changedAt).toBeLessThanOrEqual(Date.now());
    expect(connected("claude-desktop")).toBe(true);
    expect(registeredCommand(setup, "codex")).toBe(
      "/usr/local/bin/someone-elses-server",
    );
    expect(repointMoved(setup)).toEqual([]);
  });

  it("still reports the other assistants when one file can't be read", () => {
    writeJSON(claudeDesktop(), {
      mcpServers: { flockbot: { command: moved } },
    });
    // A folder where the file should be fails every read with EISDIR.
    mkdirSync(codex(), { recursive: true });

    expect(assistantStates(setup).codex.connected).toBe(false);
    expect(repointMoved(setup)).toEqual([
      { assistant: "claude-desktop", changedAt: expect.any(Number) },
    ]);
    expect(connected("claude-desktop")).toBe(true);
  });

  // Root ignores the permissions this test relies on.
  it.skipIf(asRoot)("reports a failed takeover with a message to show", () => {
    write(codex(), `[mcp_servers.flockbot]\ncommand = "${moved}"\n`);
    chmodSync(codex(), 0o400);
    chmodSync(dirname(codex()), 0o500);
    try {
      expect(repointMoved(setup)).toEqual([
        {
          assistant: "codex",
          error: expect.stringMatching(
            /^Flockbot couldn't change this assistant's settings\./,
          ),
        },
      ]);
    } finally {
      chmodSync(dirname(codex()), 0o700);
    }
  });
});

describe("the connector's assistant commands", () => {
  const reply = (args: string[]) => {
    const result = runAssistantCommand(args, setup);
    return {
      ...result,
      json: result.stdout ? JSON.parse(result.stdout) : undefined,
    };
  };

  it("reply with exactly one JSON line and exit 0", () => {
    const connected = reply(["connect", "codex"]);
    expect(connected).toMatchObject({
      stderr: "",
      exitCode: 0,
      json: { changed: true },
    });
    expect(connected.stdout.split("\n")).toEqual([
      JSON.stringify({ changed: true }),
      "",
    ]);

    expect(reply(["assistants"]).json).toEqual({
      "claude-desktop": { connected: false, commandLine: false },
      "claude-code": { connected: false, commandLine: expect.any(Boolean) },
      codex: { connected: true, commandLine: expect.any(Boolean) },
    });
    expect(reply(["repoint"]).json).toEqual({ results: [] });
    expect(reply(["disconnect", "codex"]).json).toEqual({ changed: true });
  });

  it("reply with a message to show when a change fails, still exiting 0", () => {
    write(claudeDesktop(), "not json");
    expect(reply(["connect", "claude-desktop"])).toMatchObject({
      exitCode: 0,
      json: {
        error: `Flockbot couldn't read ${claudeDesktop()}, so it left the file unchanged.`,
      },
    });
  });

  it("reject an unknown assistant with usage and exit 2", () => {
    for (const args of [["connect", "bogus"], ["disconnect"]]) {
      const result = reply(args);
      expect(result).toMatchObject({ stdout: "", exitCode: 2 });
      expect(result.stderr).toMatch(
        /^Usage: flockbot-mcp (connect|disconnect) </,
      );
    }
  });
});
