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
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { zipDirectory } from "./archive.mjs";
import { CODEX_VERSION } from "./browser-build.mjs";

export const FLOCKNOTE_TOOLS = [
  "flocknote_add_member",
  "flocknote_connect",
  "flocknote_groups",
  "flocknote_status",
  "flocknote_subscriber_count",
];
const scratch = await mkdtemp(
  join(await realpath(tmpdir()), "flockbot-browser-package-"),
);
try {
  const payload = join(scratch, "runtime payload");
  await cp(resolve("adapters/mcp/dist/browser"), payload, { recursive: true });
  const nodeFile = process.platform === "win32" ? "node.exe" : "node";
  await copyFile(process.execPath, join(payload, nodeFile));
  // Offline package checks never download a browser. Real Chromium is a separate
  // opt-in integration check; this fixture verifies the bootstrap/stdio path.
  await writeFile(
    join(payload, "setup-browser.mjs"),
    'import {writeFileSync} from "node:fs"; writeFileSync(new URL("./browser-setup-ran", import.meta.url), "fictional-check");\n',
  );
  const archive = join(scratch, "runtime.zip");
  await zipDirectory(payload, archive);
  const sha256 = createHash("sha256")
    .update(await readFile(archive))
    .digest("hex");
  const home = join(scratch, "home");
  await mkdir(home);
  const environment = {
    PATH: process.env.PATH ?? "",
    HOME: home,
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
    execFileSync(setupCommand, setupArgs(archive), {
      env: environment,
      stdio: "pipe",
    });
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
    const config = JSON.parse(await readFile(join(plugin, ".mcp.json"), "utf8"))
      .mcpServers.flocknote;
    command = config.command;
    args = config.args.map((argument) =>
      argument.replace(/^\.\//, `${plugin}/`),
    );
  }
  const client = new Client({ name: "offline-package-check", version: "1" });
  await client.connect(
    new StdioClientTransport({
      command,
      args,
      env: environment,
      stderr: "pipe",
    }),
  );
  try {
    assert.deepEqual(
      (await client.listTools()).tools.map(({ name }) => name).sort(),
      FLOCKNOTE_TOOLS,
    );
    const status = await client.callTool({ name: "flocknote_status" });
    assert.equal(
      status.structuredContent.state,
      "not_configured",
      `Offline status failed with code: ${status.structuredContent.code ?? "unknown"}`,
    );
    assert.equal(JSON.stringify(status).includes(scratch), false);
  } finally {
    await client.close();
    // The browser owner deliberately outlives an MCP client; clean up the
    // disposable owner's socket before deleting its test home.
    execFileSync(
      runtimeNode,
      ["--disable-warning=ExperimentalWarning", runtimeEntry, "stop"],
      { env: environment, stdio: "pipe" },
    );
  }
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
  console.log(
    "Codex browser package exposes the expected stdio tools; offline bootstrap verifies integrity and handles spaces.",
  );
} finally {
  await rm(scratch, { recursive: true, force: true });
}
