import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { zipDirectory } from "./archive.mjs";
import { CODEX_VERSION } from "./browser-build.mjs";

export const FLOCKNOTE_TOOLS = [
  "add_member",
  "connect",
  "email_analytics",
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
  "status",
  "subscriber_count",
];
const scratch = await mkdtemp(
  join(await realpath(tmpdir()), "flockbot-browser-package-"),
);
const failures = [];
const cleanup = [];
let phase = "preparing the offline runtime";
let launcherStderr = Buffer.alloc(0);
try {
  const payload = join(scratch, "runtime payload");
  await cp(resolve("adapters/mcp/dist/browser"), payload, { recursive: true });
  const nodeFile = process.platform === "win32" ? "node.exe" : "node";
  await copyFile(process.execPath, join(payload, nodeFile));
  // Offline package checks never download a browser. Real Chromium is a separate
  // opt-in integration check; this fixture verifies the bootstrap/stdio path.
  await writeFile(
    join(payload, "setup-browser.mjs"),
    'import {writeFileSync} from "node:fs"; await new Promise(resolve => setTimeout(resolve, 250)); if (process.env.FLOCKBOT_TEST_SETUP_EXIT) process.exit(Number(process.env.FLOCKBOT_TEST_SETUP_EXIT)); writeFileSync(new URL("./browser-setup-ran", import.meta.url), "fictional-check");\n',
  );
  const archive = join(scratch, "runtime.zip");
  await zipDirectory(payload, archive);
  const sha256 = createHash("sha256")
    .update(await readFile(archive))
    .digest("hex");
  const home = join(scratch, "home");
  await mkdir(home);
  const environment = {
    // Use the same host prerequisites for SDK launches and direct stop calls.
    ...getDefaultEnvironment(),
    PATH: process.env.PATH ?? "",
    HOME: home,
    FLOCKBOT_UPDATE_CHECKS: "0",
    USERPROFILE: home,
    LOCALAPPDATA: join(home, "AppData/Local"),
    FLOCKBOT_INSTALL_ROOT: join(scratch, "installed runtime with spaces"),
    ...(process.platform === "win32"
      ? { SystemRoot: process.env.SystemRoot, TEMP: scratch, TMP: scratch }
      : {}),
  };
  let command = process.execPath;
  let runtimeEntry = join(payload, "server/index.mjs");
  let runtimeNode = process.execPath;
  let args = [
    "--disable-warning=ExperimentalWarning",
    join(payload, "server/index.mjs"),
  ];
  const hostPlugin =
    process.platform === "darwin" && process.arch === "arm64"
      ? "flockbot-macos"
      : process.platform === "win32" && process.arch === "x64"
        ? "flockbot-windows"
        : undefined;
  if (hostPlugin) {
    phase = "checking native installation";
    const plugin = join(scratch, "plugin folder with spaces");
    await cp(resolve("plugins", hostPlugin), plugin, { recursive: true });
    await writeFile(join(plugin, "runtime.sha256"), `${sha256}\n`);
    const setupCommand =
      process.platform === "win32" ? "powershell.exe" : "/bin/bash";
    const setupArgs = (bundle) =>
      process.platform === "win32"
        ? [
            "-NoProfile",
            "-NonInteractive",
            "-File",
            join(plugin, "setup.ps1"),
            ...(bundle ? ["-Bundle", bundle] : []),
          ]
        : [join(plugin, "setup.sh"), ...(bundle ? [bundle] : [])];
    const corrupt = join(scratch, "corrupt.zip");
    await writeFile(corrupt, "fictional-corrupt-bundle");
    assert.notEqual(
      spawnSync(setupCommand, setupArgs(corrupt), {
        env: environment,
      }).status,
      0,
    );
    const windowsProbeArgs = (bundle) => [
      "-NoProfile",
      "-NonInteractive",
      "-File",
      resolve("test/mcp/fixtures/windows-setup-file-locks.ps1"),
      "-Plugin",
      plugin,
      "-Bundle",
      bundle,
    ];
    if (process.platform === "win32") {
      execFileSync(
        setupCommand,
        [...windowsProbeArgs(corrupt), "-PreserveFailure"],
        {
          env: {
            ...environment,
            FLOCKBOT_INSTALL_ROOT: join(scratch, "failed runtime with spaces"),
          },
          stdio: "pipe",
          timeout: 30_000,
        },
      );
      const failedRoot = join(scratch, "browser failure with spaces");
      const failedBrowser = spawnSync(setupCommand, setupArgs(archive), {
        env: {
          ...environment,
          FLOCKBOT_INSTALL_ROOT: failedRoot,
          FLOCKBOT_TEST_SETUP_EXIT: "17",
        },
        encoding: "utf8",
      });
      assert.notEqual(failedBrowser.status, 0);
      assert.match(
        failedBrowser.stderr,
        /browser setup failed \(exit code 17\)/,
      );
      assert.doesNotMatch(
        `${failedBrowser.stdout}${failedBrowser.stderr}`,
        /runtime is ready/,
      );
      await assert.rejects(
        readFile(
          join(
            failedRoot,
            "runtimes",
            `${CODEX_VERSION}-win32-x64-${sha256.slice(0, 12)}`,
            ".complete",
          ),
        ),
      );
    }
    execFileSync(
      setupCommand,
      process.platform === "win32"
        ? windowsProbeArgs(archive)
        : setupArgs(archive),
      {
        env: environment,
        stdio: "pipe",
      },
    );
    const root = join(
      environment.FLOCKBOT_INSTALL_ROOT,
      "runtimes",
      `${CODEX_VERSION}-${process.platform}-${process.arch}-${sha256.slice(0, 12)}`,
    );
    runtimeEntry = join(root, "server/index.mjs");
    runtimeNode = join(root, nodeFile);
    assert.equal(
      await readFile(join(root, "browser-setup-ran"), "utf8"),
      "fictional-check",
    );
    if (process.platform === "darwin") {
      // Setup repairs an owned incomplete target rather than requiring deletion.
      await rm(join(root, ".complete"));
      execFileSync(setupCommand, setupArgs(archive), {
        env: environment,
        stdio: "pipe",
      });
      assert.ok(await readFile(join(root, ".complete"), "utf8"));
      assert.equal(
        await readFile(join(root, "browser-setup-ran"), "utf8"),
        "fictional-check",
      );
    } else {
      // Windows retains its original incomplete-target failure contract.
      const marker = await readFile(join(root, ".complete"));
      await rm(join(root, ".complete"));
      const incomplete = spawnSync(setupCommand, setupArgs(archive), {
        env: environment,
        encoding: "utf8",
      });
      assert.notEqual(incomplete.status, 0);
      assert.doesNotMatch(
        `${incomplete.stdout}${incomplete.stderr}`,
        /runtime is ready/,
      );
      await assert.rejects(readFile(join(root, ".complete")));
      await writeFile(join(root, ".complete"), marker);
    }
    // An already complete immutable runtime can be reused without its archive.
    await rm(archive);
    execFileSync(setupCommand, setupArgs(), {
      env: environment,
      stdio: "pipe",
    });
    if (process.platform === "win32") {
      phase = "checking Windows launcher output and exit status";
      // This SDK-style environment omits PATHEXT. The launcher must still wait
      // for Node and preserve the caller's pipes instead of opening a console.
      const stopped = spawnSync(setupCommand, [...setupArgs(), "-Stop"], {
        env: environment,
        encoding: "utf8",
        timeout: 45_000,
      });
      assert.equal(stopped.status, 0, stopped.stderr || stopped.error?.message);
      assert.match(stopped.stdout, /The local browser owner was stopped/);
      const originalEntry = await readFile(runtimeEntry);
      try {
        await writeFile(
          runtimeEntry,
          'process.stdout.write("fictional-runtime-stdout\\n"); process.stderr.write("fictional-runtime-stderr\\n"); process.exit(17);\n',
        );
        const failed = spawnSync(setupCommand, [...setupArgs(), "-Launch"], {
          env: environment,
          encoding: "utf8",
          timeout: 45_000,
        });
        assert.equal(failed.status, 17, failed.stderr || failed.error?.message);
        assert.equal(failed.stdout.trim(), "fictional-runtime-stdout");
        assert.equal(failed.stderr.trim(), "fictional-runtime-stderr");
      } finally {
        await writeFile(runtimeEntry, originalEntry);
      }
    }
    const config = JSON.parse(await readFile(join(plugin, ".mcp.json"), "utf8"))
      .mcpServers.flocknote;
    command = config.command;
    args = config.args.map((argument) =>
      argument.replace(/^\.\//, `${plugin}/`),
    );
  }
  const client = new Client({ name: "offline-package-check", version: "1" });
  // Register both operations before initialization: a failed handshake can
  // still leave a proxy or detached browser owner running.
  cleanup.push(
    ["closing the MCP client", () => client.close()],
    [
      "stopping the browser owner",
      () => {
        execFileSync(
          runtimeNode,
          ["--disable-warning=ExperimentalWarning", runtimeEntry, "stop"],
          { env: environment, stdio: "pipe", timeout: 45_000 },
        );
      },
    ],
  );
  if (process.platform === "win32") {
    cleanup.push([
      "waiting for Windows runtime processes",
      () => {
        execFileSync(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-File",
            resolve("scripts/mcp/wait-package-runtime.ps1"),
            "-RuntimeNode",
            runtimeNode,
          ],
          { env: environment, stdio: "pipe", timeout: 30_000 },
        );
      },
    ]);
  }
  phase = "initializing MCP through the plugin launcher";
  const transport = new StdioClientTransport({
    command,
    args,
    env: environment,
    stderr: "pipe",
  });
  transport.stderr.on("data", (chunk) => {
    // This check only launches its disposable, unconfigured fixture profile.
    launcherStderr = Buffer.concat([
      launcherStderr,
      Buffer.from(chunk),
    ]).subarray(-8192);
  });
  await client.connect(transport);
  phase = "listing MCP tools";
  assert.deepEqual(
    (await client.listTools()).tools.map(({ name }) => name).sort(),
    FLOCKNOTE_TOOLS,
  );
  phase = "reading offline status";
  const status = await client.callTool({ name: "status" });
  assert.equal(
    status.structuredContent.state,
    "not_configured",
    `Offline status failed with code: ${status.structuredContent.code ?? "unknown"}`,
  );
  assert.equal(JSON.stringify(status).includes(scratch), false);
  phase = "checking offline failure attribution";
  const failed = await client.callTool({
    name: "subscriber_count",
    arguments: { groupId: "101" },
  });
  assert.equal(failed.structuredContent.code, "not_configured");
  const diagnostic = failed.structuredContent.diagnostic;
  const fingerprint = createHash("sha256")
    .update(await readFile(runtimeEntry))
    .digest("hex");
  assert.equal(diagnostic.runtime.fingerprint, fingerprint);
  assert.equal(diagnostic.browserRuntime.fingerprint, fingerprint);
  assert.equal(diagnostic.runtime.version, CODEX_VERSION);
  assert.equal(JSON.stringify(diagnostic).includes(scratch), false);
  assert.equal(diagnostic.traceSaved, true);
  const exported = execFileSync(
    process.execPath,
    [runtimeEntry, "diagnostics"],
    {
      env: environment,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(exported, [diagnostic]);
  phase = "checking plugin manifests";
  for (const name of ["flockbot-macos", "flockbot-windows"]) {
    const root = resolve("plugins", name);
    const plugin = JSON.parse(
      await readFile(join(root, ".codex-plugin/plugin.json"), "utf8"),
    );
    assert.equal(plugin.name, name);
    assert.equal(plugin.version, CODEX_VERSION);
    assert.equal(plugin.requires_local_executor, true);
    assert.match(
      await readFile(join(root, "runtime.sha256"), "utf8"),
      /^[a-f0-9]{64}\n$/,
    );
    assert.ok(await readFile(join(root, plugin.onboardingSkill), "utf8"));
  }
} catch (error) {
  failures.push(
    new Error(
      `Browser package check failed while ${phase}.${launcherStderr.length ? `\nLauncher stderr (last 8192 bytes):\n${launcherStderr.toString("utf8")}` : ""}`,
      { cause: error },
    ),
  );
} finally {
  // Attempt every cleanup step and retain the original failure, even if stopping
  // a child or removing its executable also fails.
  for (const [operation, close] of cleanup) {
    try {
      await close();
    } catch (error) {
      failures.push(
        new Error(`Browser package cleanup failed while ${operation}.`, {
          cause: error,
        }),
      );
    }
  }
  try {
    await rm(scratch, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  } catch (error) {
    failures.push(
      new Error(
        "Browser package cleanup could not remove its disposable runtime.",
        { cause: error },
      ),
    );
  }
}
if (failures.length)
  throw new AggregateError(failures, "Browser package verification failed.");
console.log(
  "Codex browser package exposes the expected stdio tools; offline bootstrap verifies integrity and handles spaces.",
);
