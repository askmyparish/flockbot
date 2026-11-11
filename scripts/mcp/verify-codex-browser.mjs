// Explicit host check. Uses a disposable home/configuration and no account login.
// It verifies actual Codex plugin parsing and MCP launch, not the desktop GUI.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { CODEX_VERSION } from "./browser-build.mjs";
import { prepareCodexBrowserHome } from "./codex-browser-fixture.mjs";

assert.equal(
  process.platform,
  "darwin",
  "This host check currently targets macOS.",
);
assert.equal(
  process.arch,
  "arm64",
  "This host check currently targets Apple silicon.",
);
const {
  scratch,
  home: temporaryHome,
  codexHome,
  installRoot,
} = await prepareCodexBrowserHome(resolve("adapters/mcp/.cache/browsers"));
const env = {
  PATH: process.env.PATH ?? "",
  HOME: temporaryHome,
  FLOCKBOT_UPDATE_CHECKS: "0",
  USERPROFILE: temporaryHome,
  CODEX_HOME: codexHome,
  FLOCKBOT_INSTALL_ROOT: installRoot,
};
const options = {
  env,
  cwd: temporaryHome,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
};

function statusOverAppServer() {
  return new Promise((resolveStatus, reject) => {
    const server = spawn("codex", ["app-server"], {
      env,
      cwd: temporaryHome,
      stdio: ["pipe", "pipe", "ignore"],
    });
    const limit = setTimeout(() => {
      server.kill();
      reject(new Error("Codex did not report plugin tools within 45 seconds."));
    }, 45_000);
    let finished = false;
    const send = (message) =>
      server.stdin.write(`${JSON.stringify(message)}\n`);
    createInterface({ input: server.stdout }).on("line", (line) => {
      const message = JSON.parse(line);
      if (message.error) {
        finished = true;
        clearTimeout(limit);
        server.kill();
        reject(new Error("Codex app-server rejected the status request."));
      } else if (message.id === 1) {
        send({ method: "initialized" });
        send({ id: 2, method: "mcpServerStatus/list", params: {} });
      } else if (message.id === 2) {
        finished = true;
        clearTimeout(limit);
        server.kill();
        resolveStatus(message.result.data);
      }
    });
    server.once("error", () => {
      clearTimeout(limit);
      reject(new Error("Codex app-server could not start."));
    });
    server.once("exit", () => {
      if (!finished) {
        clearTimeout(limit);
        reject(new Error("Codex app-server exited before listing tools."));
      }
    });
    send({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "flockbot-codex-check", version: "1" },
        capabilities: { experimentalApi: true },
      },
    });
  });
}

try {
  execFileSync(
    "/bin/bash",
    [
      resolve("plugins/flockbot-macos/setup.sh"),
      resolve(
        `adapters/mcp/artifacts/codex/flockbot-codex-${CODEX_VERSION}-darwin-arm64.zip`,
      ),
    ],
    options,
  );
  execFileSync(
    "codex",
    ["plugin", "marketplace", "add", resolve(".")],
    options,
  );
  execFileSync("codex", ["plugin", "add", "flockbot-macos@flockbot"], options);
  const statuses = await statusOverAppServer();
  const flocknote = statuses.find(({ name }) => name === "flocknote");
  assert.ok(flocknote, "Codex did not load the Flocknote plugin.");
  assert.equal(flocknote.toolsError, null);
  assert.deepEqual(Object.keys(flocknote.tools).sort(), [
    "add_member",
    "connect",
    "email_analytics",
    "email_recipients",
    "find_members",
    "find_notes",
    "group_members",
    "group_notes",
    "groups",
    "is_member",
    "member",
    "member_communication_status",
    "member_groups",
    "member_latest_email_status",
    "note",
    "status",
    "subscriber_count",
  ]);
  console.log(
    JSON.stringify({
      codex: execFileSync("codex", ["--version"], options).trim(),
      plugin: flocknote.pluginId,
      tools: Object.keys(flocknote.tools).sort(),
      surface:
        "Codex app-server with a disposable configuration; no live Flocknote access",
    }),
  );
  const config = await readFile(
    join(temporaryHome, ".codex/config.toml"),
    "utf8",
  );
  assert.match(config, /flockbot/);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
