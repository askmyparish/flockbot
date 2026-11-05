import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { zipSync } from "fflate";
import { afterAll, describe, expect, it } from "vitest";
import { prepareCodexBrowserHome } from "../../scripts/mcp/codex-browser-fixture.mjs";
import { zipDirectory } from "../../scripts/mcp/archive.mjs";

const roots = [];
const children = new Set();
afterAll(async () => {
  // Unblock fixture-only preparation before cleaning up failed assertions.
  for (const root of roots) await rm(join(root, "gate"), { force: true });
  await delay(100);
  for (const root of roots) {
    const events = (
      await readFile(join(root, "events"), "utf8").catch(() => "")
    )
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const descendant = Number(
      await readFile(join(root, "descendant-pid"), "utf8").catch(() => ""),
    );
    for (const pid of [
      ...events.flatMap((event) => [event.pid, event.parent, event.helper]),
      descendant,
    ]) {
      if (!pid) continue;
      try {
        if (
          execFileSync("/bin/ps", ["-o", "command=", "-p", String(pid)], {
            encoding: "utf8",
          }).includes(root)
        )
          process.kill(pid, "SIGKILL");
      } catch {}
    }
  }
  for (const child of children) child.kill("SIGKILL");
  for (const root of roots) await rm(root, { recursive: true, force: true });
});
const mac = process.platform === "darwin" && process.arch === "arm64";
async function fixture({ defaultRoot = false } = {}) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "flockbot-setup-"));
  roots.push(root);
  const plugin = join(root, "plugin with spaces");
  await cp(resolve("plugins/flockbot-macos"), plugin, { recursive: true });
  const version = (
    await readFile(join(plugin, "runtime.version"), "utf8")
  ).trim();
  const payload = join(root, "prepared payload");
  const bin = join(root, "bin");
  const home = join(root, "home");
  await mkdir(join(payload, "node_modules/playwright"), { recursive: true });
  await mkdir(join(payload, "server"));
  await mkdir(bin);
  await mkdir(home);
  // Tiny fixture executable delegates to this test's Node, never PATH/global
  // staff prerequisites. check-browser-package additionally tests a real binary.
  await writeFile(
    join(payload, "node"),
    `#!/bin/bash\necho invoked >> "$FIXTURE_EXECUTIONS"\nexec '${process.execPath.replaceAll("'", "'\\''")}' "$@"\n`,
  );
  await chmod(join(payload, "node"), 0o755);
  await writeFile(
    join(payload, "package.json"),
    `${JSON.stringify({ name: "flockbot-local-runtime", version, private: true, type: "module" })}\n`,
  );
  await writeFile(
    join(payload, "server/index.mjs"),
    'import {appendFileSync} from "node:fs"; appendFileSync(process.env.FIXTURE_ACTIONS, (process.argv[2] ?? "launch")+"\\n");\n',
  );
  await copyFile(
    "scripts/mcp/setup-browser.mjs",
    join(payload, "setup-browser.mjs"),
  );
  await writeFile(
    join(payload, "node_modules/playwright/cli.js"),
    `const fs = require("node:fs");
if (process.env.FIXTURE_DESCENDANT) {
  require("node:child_process").fork(require("node:path").join(__dirname,"downloader.cjs"), [], {stdio:["ignore","ignore","ignore","ipc"]});
}
const helper = Number(require("node:child_process").execFileSync("/bin/ps", ["-o","ppid=","-p",String(process.ppid)], {encoding:"utf8"}).trim());
fs.appendFileSync(process.env.FIXTURE_EVENTS, JSON.stringify({event:"start",pid:process.pid,parent:process.ppid,helper,timeout:process.env.PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT,mirror:process.env.PLAYWRIGHT_DOWNLOAD_HOST,npmMirror:process.env.npm_config_playwright_chromium_download_host})+"\\n");
const tick = setInterval(() => {
  if (fs.existsSync(process.env.FIXTURE_GATE)) return;
  clearInterval(tick);
  if (fs.existsSync(process.env.FIXTURE_FAIL)) { console.error("fictional-private-upstream-detail"); process.exitCode=1; }
  else fs.appendFileSync(process.env.FIXTURE_EVENTS, JSON.stringify({event:"done",pid:process.pid})+"\\n");
}, 20);
`,
  );
  await writeFile(
    join(payload, "node_modules/playwright/downloader.cjs"),
    `const fs=require("node:fs");
for (const signal of ["SIGINT","SIGTERM","SIGHUP"]) process.on(signal,()=>{});
process.on("disconnect",()=>{});
fs.writeFileSync(process.env.FIXTURE_DESCENDANT, String(process.pid));
setInterval(()=>{if(!fs.existsSync(process.env.FIXTURE_GATE))process.exit(0)},20);
`,
  );
  await writeFile(
    join(bin, "curl"),
    '#!/bin/bash\nprintf "%s\\n" "$@" >> "$FIXTURE_CURL_LOG"\nif [[ -f "$FIXTURE_DOWNLOAD_FAIL" ]]; then echo fictional-private-upstream-detail >&2; exit 28; fi\nwhile [[ $# -gt 0 ]]; do if [[ "$1" == --output ]]; then cp "$FIXTURE_ARCHIVE" "$2"; exit; fi; shift; done\nexit 1\n',
  );
  await chmod(join(bin, "curl"), 0o755);
  const archive = join(root, "runtime.zip");
  const env = {
    PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: home,
    USERPROFILE: home,
    LOCALAPPDATA: join(home, "local"),
    TMPDIR: root,
    FLOCKBOT_INSTALL_ROOT: join(root, "installation with spaces"),
    FIXTURE_EXECUTIONS: join(root, "executions"),
    FIXTURE_EVENTS: join(root, "events"),
    FIXTURE_ACTIONS: join(root, "actions"),
    FIXTURE_GATE: join(root, "gate"),
    FIXTURE_FAIL: join(root, "fail"),
    FIXTURE_ARCHIVE: archive,
    FIXTURE_CURL_LOG: join(root, "downloads"),
    FIXTURE_DOWNLOAD_FAIL: join(root, "download-fail"),
  };
  if (defaultRoot) delete env.FLOCKBOT_INSTALL_ROOT;
  const installRoot = defaultRoot
    ? join(home, "Library/Application Support/Flockbot MCP")
    : env.FLOCKBOT_INSTALL_ROOT;
  const f = {
    installRoot,
    root,
    plugin,
    payload,
    archive,
    env,
    async pack(bytes) {
      if (bytes) await writeFile(archive, bytes);
      else await zipDirectory(payload, archive);
      const digest = createHash("sha256")
        .update(await readFile(archive))
        .digest("hex");
      await writeFile(join(plugin, "runtime.sha256"), `${digest}\n`);
      f.runtime = join(
        installRoot,
        "runtimes",
        `${version}-darwin-arm64-${digest.slice(0, 12)}`,
      );
      return digest;
    },
    start(args = [archive]) {
      const child = spawn("/bin/bash", [join(plugin, "setup.sh"), ...args], {
        env,
        detached: true,
      });
      children.add(child);
      let output = "";
      child.stdout.on("data", (data) => {
        output += data;
      });
      child.stderr.on("data", (data) => {
        output += data;
      });
      const result = new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => {
          children.delete(child);
          resolve({ code, signal, output });
        });
      });
      return { child, result };
    },
    async run(args) {
      return f.start(args).result;
    },
    async events() {
      return (await readFile(env.FIXTURE_EVENTS, "utf8").catch(() => ""))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    },
  };
  await f.pack();
  return f;
}
async function until(work) {
  const end = Date.now() + 5000;
  while (Date.now() < end) {
    if (await work()) return;
    await delay(20);
  }
  throw new Error("Fixture process did not reach the expected checkpoint.");
}
async function exists(path) {
  return stat(path).then(
    () => true,
    () => false,
  );
}
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function assertReady(f, result) {
  expect(result, result.output).toMatchObject({ code: 0 });
  expect(result.output).toContain("runtime is ready");
  expect(await exists(join(f.runtime, ".complete"))).toBe(true);
  expect(await exists(join(f.runtime, "payload"))).toBe(false);
}

describe.skipIf(!mac)("macOS runtime setup processes (offline)", () => {
  it("retains the supervisor lock and stage after shell AND helper SIGKILL, bounds surviving CLI/downloader work, then retries", async () => {
    const f = await fixture();
    const helperPath = join(f.payload, "setup-browser.mjs");
    await writeFile(
      helperPath,
      (await readFile(helperPath, "utf8")).replace("300_000", "2500"),
    );
    await f.pack();
    await writeFile(f.env.FIXTURE_GATE, "hold");
    f.env.FIXTURE_DESCENDANT = join(f.root, "descendant-pid");
    const first = f.start();
    await until(async () => (await f.events()).length === 1);
    await until(() => exists(f.env.FIXTURE_DESCENDANT));
    const [{ pid, parent: supervisor, helper }] = await f.events();
    const descendant = Number(await readFile(f.env.FIXTURE_DESCENDANT, "utf8"));
    // Real boundaries: shell -> helper -> detached supervisor -> CLI group ->
    // IPC-forked downloader, which has no lock fd and ignores catchable signals.
    expect(
      new Set([first.child.pid, helper, supervisor, pid, descendant]).size,
    ).toBe(5);
    first.child.kill("SIGKILL");
    process.kill(helper, "SIGKILL");
    expect((await first.result).signal).toBe("SIGKILL");
    const stages = join(f.installRoot, ".setup-stages");
    const [stage] = await readdir(stages);
    f.env.FIXTURE_GATE = join(f.root, "retry-gate");
    delete f.env.FIXTURE_DESCENDANT;
    const retry = f.start();
    await delay(300);
    for (const active of [supervisor, pid, descendant])
      expect(() => process.kill(active, 0)).not.toThrow();
    expect(await readdir(stages)).toEqual([stage]);
    expect(
      await exists(
        join(stages, stage, "payload/node_modules/playwright/downloader.cjs"),
      ),
    ).toBe(true);
    expect(await exists(f.runtime)).toBe(false);
    expect(await f.events()).toHaveLength(1);
    await assertReady(f, await retry.result);
    for (const active of [supervisor, pid, descendant])
      await until(() => !alive(active));
    expect(await readdir(stages)).toEqual([]);
    expect((await f.events()).map(({ event }) => event)).toEqual([
      "start",
      "start",
      "done",
    ]);
  }, 15000);

  it("leaves the stage locked when only the helper is SIGKILLed and the shell exits on failure", async () => {
    const f = await fixture();
    const helperPath = join(f.payload, "setup-browser.mjs");
    await writeFile(
      helperPath,
      (await readFile(helperPath, "utf8")).replace("300_000", "2500"),
    );
    await f.pack();
    await writeFile(f.env.FIXTURE_GATE, "hold");
    const first = f.start();
    await until(async () => (await f.events()).length === 1);
    const [{ pid, parent: supervisor, helper }] = await f.events();
    process.kill(helper, "SIGKILL");
    const failed = await first.result;
    expect(failed.code).not.toBe(0);
    expect(failed.output).not.toContain("runtime is ready");
    const stages = join(f.installRoot, ".setup-stages");
    const [stage] = await readdir(stages);
    expect(alive(pid)).toBe(true);
    f.env.FIXTURE_GATE = join(f.root, "retry-gate");
    const retry = f.start();
    await delay(300);
    expect(await readdir(stages)).toEqual([stage]);
    expect(await exists(join(stages, stage, "payload/node"))).toBe(true);
    expect(await f.events()).toHaveLength(1);
    await assertReady(f, await retry.result);
    await until(() => !alive(supervisor) && !alive(pid));
  }, 15000);

  it("stops a downloader without fd 9 when the CLI dies after its shell and helper", async () => {
    const f = await fixture();
    await writeFile(f.env.FIXTURE_GATE, "hold");
    f.env.FIXTURE_DESCENDANT = join(f.root, "descendant-pid");
    const first = f.start();
    await until(async () => (await f.events()).length === 1);
    await until(() => exists(f.env.FIXTURE_DESCENDANT));
    const [{ pid, parent: supervisor, helper }] = await f.events();
    const descendant = Number(await readFile(f.env.FIXTURE_DESCENDANT, "utf8"));
    first.child.kill("SIGKILL");
    process.kill(helper, "SIGKILL");
    process.kill(pid, "SIGKILL");
    await first.result;
    await until(() => !alive(descendant));
    await until(() => !alive(supervisor));
    await rm(f.env.FIXTURE_GATE);
    delete f.env.FIXTURE_DESCENDANT;
    await assertReady(f, await f.run());
  }, 15000);

  it.each([
    ["SIGINT", "group"],
    ["SIGTERM", "group"],
    ["SIGHUP", "group"],
    ["SIGTERM", "shell"],
    ["SIGTERM", "helper"],
  ])(
    "cancels %s sent to the %s without readiness or surviving downloads",
    async (signal, target) => {
      const f = await fixture();
      await writeFile(f.env.FIXTURE_GATE, "hold");
      f.env.FIXTURE_DESCENDANT = join(f.root, "descendant-pid");
      const first = f.start();
      await until(async () => (await f.events()).length === 1);
      await until(() => exists(f.env.FIXTURE_DESCENDANT));
      const [{ pid, parent: supervisor, helper }] = await f.events();
      const descendant = Number(
        await readFile(f.env.FIXTURE_DESCENDANT, "utf8"),
      );
      process.kill(
        target === "group"
          ? -first.child.pid
          : target === "helper"
            ? helper
            : first.child.pid,
        signal,
      );
      const cancelled = await first.result;
      expect(cancelled.code).not.toBe(0);
      expect(cancelled.output).not.toContain("runtime is ready");
      expect(await exists(f.runtime)).toBe(false);
      for (const active of [helper, supervisor, pid, descendant])
        await until(() => !alive(active));
      await rm(f.env.FIXTURE_GATE);
      delete f.env.FIXTURE_DESCENDANT;
      await assertReady(f, await f.run());
    },
    15000,
  );

  it("preserves default-base profile, connection and broker data through failure, death, repair and retry", async () => {
    const f = await fixture({ defaultRoot: true });
    expect(f.env.FLOCKBOT_INSTALL_ROOT).toBeUndefined();
    const sentinels = [
      "browser-v1/fictional-session",
      "browser-v1/connection.json",
      "browser-v1/broker.json",
    ];
    await mkdir(join(f.installRoot, "browser-v1"), { recursive: true });
    for (const name of sentinels)
      await writeFile(join(f.installRoot, name), `fictional-preserve-${name}`);
    const preserved = async () => {
      for (const name of sentinels)
        expect(await readFile(join(f.installRoot, name), "utf8")).toBe(
          `fictional-preserve-${name}`,
        );
    };
    await writeFile(f.env.FIXTURE_FAIL, "fail");
    expect((await f.run()).code).not.toBe(0);
    await preserved();
    await rm(f.env.FIXTURE_FAIL);
    await writeFile(f.env.FIXTURE_GATE, "hold");
    const first = f.start();
    await until(
      async () =>
        (await f.events()).filter((e) => e.event === "start").length === 2,
    );
    const event = (await f.events()).filter((e) => e.event === "start")[1];
    first.child.kill("SIGKILL");
    process.kill(event.helper, "SIGKILL");
    process.kill(event.pid, "SIGKILL");
    await first.result;
    await until(() => !alive(event.parent));
    await preserved();
    const foreign = join(f.installRoot, ".setup-stages/stage.foreign");
    await mkdir(foreign);
    await writeFile(join(foreign, ".owner"), "somebody else");
    await rm(f.env.FIXTURE_GATE);
    await assertReady(f, await f.run());
    await preserved();
    await rm(join(f.runtime, ".complete"));
    await writeFile(join(f.runtime, "partial"), "owned");
    await assertReady(f, await f.run());
    expect(await exists(join(f.runtime, "partial"))).toBe(false);
    await preserved();
    expect(await readFile(join(foreign, ".owner"), "utf8")).toBe(
      "somebody else",
    );
    expect(await readdir(join(f.installRoot, ".setup-stages"))).toEqual([
      "stage.foreign",
    ]);
  }, 15000);

  it.each([64, 71, 73, 74])(
    "reports non-contention lockf exit %s as an actionable lock failure",
    async (status) => {
      const f = await fixture();
      const lockf = join(f.root, "bin/lockf");
      await writeFile(lockf, `#!/bin/bash\nexit ${status}\n`);
      await chmod(lockf, 0o755);
      const script = join(f.plugin, "setup.sh");
      await writeFile(
        script,
        (await readFile(script, "utf8")).replaceAll("/usr/bin/lockf", lockf),
      );
      const failed = await f.run();
      expect(failed.code).not.toBe(0);
      expect(failed.output).toContain("could not acquire its setup lock");
      expect(failed.output).not.toContain("Another Flockbot setup");
      expect(failed.output).not.toContain("runtime is ready");
      expect(await f.events()).toEqual([]);
    },
  );

  it("prepares the documented verifier caller with real temp paths and an isolated direct browser cache", async () => {
    const f = await fixture();
    const alias = join(f.root, "temp-alias");
    await symlink(f.root, alias);
    const cache = join(f.root, "cache");
    await mkdir(join(cache, "chromium-fixture"), { recursive: true });
    await writeFile(
      join(cache, "chromium-fixture/binary"),
      "fictional-browser-bytes",
    );
    const prepared = await prepareCodexBrowserHome(cache, alias);
    expect(prepared.scratch).toBe(await realpath(prepared.scratch));
    const directCache = join(prepared.installRoot, "browser-engines");
    expect((await lstat(directCache)).isSymbolicLink()).toBe(false);
    await rm(cache, { recursive: true });
    expect(
      await readFile(join(directCache, "chromium-fixture/binary"), "utf8"),
    ).toBe("fictional-browser-bytes");
    f.env.HOME = prepared.home;
    f.env.CODEX_HOME = prepared.codexHome;
    f.env.FLOCKBOT_INSTALL_ROOT = prepared.installRoot;
    await f.pack();
    // pack uses the fixture's original root; only this caller assertion needs
    // the alternate prepared install location's selected runtime.
    f.runtime = join(
      prepared.installRoot,
      "runtimes",
      f.runtime.split("/").at(-1),
    );
    await assertReady(f, await f.run());
    const source = await readFile(
      "scripts/mcp/verify-codex-browser.mjs",
      "utf8",
    );
    expect(source).toContain("await prepareCodexBrowserHome(");
    expect(source).not.toContain("await symlink(");
  }, 15000);

  it("serializes concurrent setup, never steals an old lock, and never nests payloads", async () => {
    const f = await fixture();
    await writeFile(f.env.FIXTURE_GATE, "hold");
    const first = f.start();
    await until(async () => (await f.events()).length === 1);
    const lock = join(f.env.FLOCKBOT_INSTALL_ROOT, ".setup.lock");
    await utimes(lock, new Date(0), new Date(0));
    const second = f.start();
    await delay(250);
    expect((await f.events()).length).toBe(1);
    expect(await exists(f.runtime)).toBe(false);
    const stages = join(f.env.FLOCKBOT_INSTALL_ROOT, ".setup-stages");
    expect(await readdir(stages)).toHaveLength(1);
    await rm(f.env.FIXTURE_GATE);
    await assertReady(f, await first.result);
    await assertReady(f, await second.result);
    expect((await f.events()).map(({ event }) => event)).toEqual([
      "start",
      "done",
    ]);
    expect(await readdir(stages)).toEqual([]);
    expect(
      await readdir(join(f.env.FLOCKBOT_INSTALL_ROOT, "runtimes")),
    ).toHaveLength(1);
    expect(await exists(lock)).toBe(true);
  }, 15000);

  it("bounds lock wait without interrupting the active holder", async () => {
    const f = await fixture();
    const script = join(f.plugin, "setup.sh");
    await writeFile(
      script,
      (await readFile(script, "utf8")).replace("-t 120 9", "-t 1 9"),
    );
    await writeFile(f.env.FIXTURE_GATE, "hold");
    const first = f.start();
    await until(async () => (await f.events()).length === 1);
    const waiter = await f.run();
    expect(waiter.code).not.toBe(0);
    expect(waiter.output).toContain("Another Flockbot setup is still running");
    expect(waiter.output).not.toContain("runtime is ready");
    expect((await f.events()).length).toBe(1);
    await rm(f.env.FIXTURE_GATE);
    await assertReady(f, await first.result);
    await assertReady(f, await f.run());
  }, 15000);

  it("keeps an orphan's active work locked, then recovers its owned stage after shell death", async () => {
    const f = await fixture();
    await writeFile(f.env.FIXTURE_GATE, "hold");
    const first = f.start();
    await until(async () => (await f.events()).length === 1);
    first.child.kill("SIGKILL");
    expect((await first.result).signal).toBe("SIGKILL");
    const stages = join(f.env.FLOCKBOT_INSTALL_ROOT, ".setup-stages");
    const [active] = await readdir(stages);
    const second = f.start();
    await delay(250);
    expect((await f.events()).length).toBe(1);
    expect(await exists(join(stages, active, "payload"))).toBe(true);
    await rm(f.env.FIXTURE_GATE);
    await assertReady(f, await second.result);
    expect((await f.events()).map(({ event }) => event)).toEqual([
      "start",
      "done",
      "start",
      "done",
    ]);
    expect(await readdir(stages)).toEqual([]);
  }, 15000);

  it("repairs owned incomplete and empty targets, reuses immutable ready bytes without downloads, and keeps actions installation-free", async () => {
    const f = await fixture();
    for (const action of ["--launch", "--stop", "--forget"]) {
      const result = await f.run([action]);
      expect(result.code).not.toBe(0);
      expect(result.output).toContain("setup is required");
    }
    expect(await exists(f.env.FLOCKBOT_INSTALL_ROOT)).toBe(false);
    await mkdir(f.runtime, { recursive: true });
    await assertReady(f, await f.run());
    await rm(join(f.runtime, ".complete"));
    await writeFile(join(f.runtime, "interrupted-file"), "owned");
    await assertReady(f, await f.run());
    expect(await exists(join(f.runtime, "interrupted-file"))).toBe(false);
    // Original completed runtimes used an empty marker and no ownership receipt.
    await writeFile(join(f.runtime, ".complete"), "");
    await rm(join(f.runtime, ".flockbot-runtime"));
    const before = await readFile(join(f.runtime, ".complete"));
    await rm(f.archive);
    await assertReady(f, await f.run([]));
    for (const action of ["--launch", "--stop", "--forget"]) {
      const actionResult = await f.run([action]);
      expect(actionResult.code, actionResult.output).toBe(0);
    }
    expect(await readFile(f.env.FIXTURE_ACTIONS, "utf8")).toBe(
      "launch\nstop\nforget\n",
    );
    expect(await readFile(join(f.runtime, ".complete"))).toEqual(before);
    expect(await exists(f.env.FIXTURE_CURL_LOG)).toBe(false);
    expect(
      (await f.events()).filter(({ event }) => event === "start"),
    ).toHaveLength(2);
  }, 15000);

  it("repairs legacy partial payloads only when all existing files match the pinned archive", async () => {
    const f = await fixture();
    await mkdir(join(f.runtime, "server"), { recursive: true });
    await copyFile(
      join(f.payload, "package.json"),
      join(f.runtime, "package.json"),
    );
    await copyFile(
      join(f.payload, "server/index.mjs"),
      join(f.runtime, "server/index.mjs"),
    );
    await assertReady(f, await f.run());
    await rm(join(f.runtime, ".complete"));
    await rm(join(f.runtime, ".flockbot-runtime"));
    // A complete legacy payload with its old marker lost also recovers.
    await assertReady(f, await f.run());
    await rm(join(f.runtime, ".complete"));
    await rm(join(f.runtime, ".flockbot-runtime"));
    await writeFile(join(f.runtime, "foreign"), "preserve");
    const collision = await f.run();
    expect(collision.code).not.toBe(0);
    expect(collision.output).toContain("unrecognized or damaged files");
    expect(await readFile(join(f.runtime, "foreign"), "utf8")).toBe("preserve");
    expect(
      (await f.events()).filter(({ event }) => event === "start"),
    ).toHaveLength(2);
  }, 15000);

  it("bounds downloads, sanitizes failures, and retries download, extraction and browser failures", async () => {
    const f = await fixture();
    f.env.PLAYWRIGHT_DOWNLOAD_HOST = "https://fictional-mirror.example.test";
    f.env.npm_config_playwright_chromium_download_host =
      "https://fictional-mirror.example.test";
    await writeFile(f.env.FIXTURE_DOWNLOAD_FAIL, "fail");
    const failedDownload = await f.run([]);
    expect(failedDownload.code).not.toBe(0);
    expect(failedDownload.output).toContain("download failed or timed out");
    expect(failedDownload.output).not.toContain("fictional-private");
    expect(failedDownload.output).not.toContain("runtime is ready");
    const curl = await readFile(f.env.FIXTURE_CURL_LOG, "utf8");
    expect(curl).toContain("--connect-timeout\n15\n--max-time\n180\n");
    expect(curl).toContain("--proto\n=https\n--proto-redir\n=https");
    expect(curl).toContain(
      "https://github.com/askmyparish/flockbot/releases/download/mcp-v",
    );
    await rm(f.env.FIXTURE_DOWNLOAD_FAIL);
    const unzip = join(f.root, "bin/unzip");
    await writeFile(
      unzip,
      '#!/bin/bash\nif [[ "$1" == -q ]]; then exit 1; fi\nexec /usr/bin/unzip "$@"\n',
    );
    await chmod(unzip, 0o755);
    const failedExtract = await f.run();
    expect(failedExtract.code).not.toBe(0);
    expect(failedExtract.output).toContain("extraction failed");
    await rm(unzip);
    await writeFile(f.env.FIXTURE_FAIL, "fail");
    const failedBrowser = await f.run();
    expect(failedBrowser.code).not.toBe(0);
    expect(failedBrowser.output).toContain("browser setup failed or timed out");
    expect(failedBrowser.output).not.toContain("fictional-private");
    expect(failedBrowser.output).not.toContain("runtime is ready");
    expect(await exists(f.runtime)).toBe(false);
    expect(
      await readdir(join(f.env.FLOCKBOT_INSTALL_ROOT, ".setup-stages")),
    ).toHaveLength(1);
    await rm(f.env.FIXTURE_FAIL);
    await assertReady(f, await f.run([]));
    for (const event of (await f.events()).filter(
      ({ event }) => event === "start",
    )) {
      expect(event.timeout).toBe("30000");
      expect(event.mirror).toBe(f.env.PLAYWRIGHT_DOWNLOAD_HOST);
      expect(event.npmMirror).toBe(
        f.env.npm_config_playwright_chromium_download_host,
      );
    }
  }, 15000);

  it("times out hung browser preparation, kills the active CLI and recovers on retry", async () => {
    const f = await fixture();
    // Exercise the real deadline mechanism with a shorter fixture budget.
    const helper = join(f.payload, "setup-browser.mjs");
    await writeFile(
      helper,
      (await readFile(helper, "utf8")).replace("300_000", "2500"),
    );
    await f.pack();
    await writeFile(f.env.FIXTURE_GATE, "hold");
    f.env.FIXTURE_DESCENDANT = join(f.root, "descendant-pid");
    const run = f.start();
    await until(async () => (await f.events()).length === 1);
    await until(() => exists(f.env.FIXTURE_DESCENDANT));
    const failed = await run.result;
    expect(failed.code).not.toBe(0);
    expect(failed.output).toContain("browser setup failed or timed out");
    expect(failed.output).not.toContain("runtime is ready");
    const [{ pid }] = await f.events();
    expect(() => process.kill(pid, 0)).toThrow();
    const descendant = Number(await readFile(f.env.FIXTURE_DESCENDANT, "utf8"));
    await until(async () => {
      try {
        process.kill(descendant, 0);
        return false;
      } catch {
        return true;
      }
    });
    expect(await exists(f.runtime)).toBe(false);
    await rm(f.env.FIXTURE_GATE);
    delete f.env.FIXTURE_DESCENDANT;
    await assertReady(f, await f.run());
  }, 15000);

  it("rejects a corrupt pin/archive and invalid prepared payloads before running payload bytes", async () => {
    const f = await fixture();
    await writeFile(join(f.plugin, "runtime.sha256"), "not-a-pin\n");
    expect((await f.run()).output).toContain("Invalid Flockbot release digest");
    await f.pack();
    await writeFile(f.archive, "corrupt");
    const corrupt = await f.run();
    expect(corrupt.code).not.toBe(0);
    expect(corrupt.output).toContain("integrity check");
    await rm(join(f.payload, "server/index.mjs"));
    await f.pack();
    const invalid = await f.run();
    expect(invalid.code).not.toBe(0);
    expect(invalid.output).toContain("prepared Flockbot runtime is invalid");
    expect(await exists(f.env.FIXTURE_EXECUTIONS)).toBe(false);
    expect(await exists(f.runtime)).toBe(false);
    await f.pack(
      zipSync({ "../escaped": new TextEncoder().encode("foreign") }),
    );
    expect((await f.run()).output).toContain("unsafe paths");
    expect(
      await exists(join(f.env.FLOCKBOT_INSTALL_ROOT, ".setup-stages/escaped")),
    ).toBe(false);
    await f.pack(
      zipSync({
        node: [
          new TextEncoder().encode("/outside"),
          { os: 3, attrs: 0o120777 << 16 },
        ],
      }),
    );
    expect((await f.run()).output).toContain("unsupported file types");
    expect(await exists(f.env.FIXTURE_EXECUTIONS)).toBe(false);
  }, 15000);

  it("preserves foreign collisions and rejects symlink ancestors, stages, cache and false-ready payloads", async () => {
    const f = await fixture();
    const outside = join(f.root, "unrelated");
    await mkdir(outside);
    await writeFile(join(outside, "sentinel"), "preserve");
    await mkdir(f.runtime, { recursive: true });
    await writeFile(join(f.runtime, "foreign"), "preserve");
    const collision = await f.run();
    expect(collision.code).not.toBe(0);
    expect(collision.output).toContain("unrecognized or damaged");
    expect(await readFile(join(f.runtime, "foreign"), "utf8")).toBe("preserve");
    await writeFile(join(f.runtime, ".complete"), "");
    expect((await f.run()).code).not.toBe(0);
    expect((await f.run(["--launch"])).code).not.toBe(0);
    await rm(f.env.FLOCKBOT_INSTALL_ROOT, { recursive: true });
    for (const path of [
      f.env.FLOCKBOT_INSTALL_ROOT,
      join(f.env.FLOCKBOT_INSTALL_ROOT, "runtimes"),
      join(f.env.FLOCKBOT_INSTALL_ROOT, ".setup-stages"),
      join(f.env.FLOCKBOT_INSTALL_ROOT, "browser-engines"),
      f.runtime,
    ]) {
      await mkdir(resolve(path, ".."), { recursive: true });
      await symlink(outside, path);
      const rejected = await f.run();
      expect(rejected.code).not.toBe(0);
      expect(rejected.output).toContain("symlinks");
      await rm(path);
    }
    expect(await readdir(outside)).toEqual(["sentinel"]);
    expect(await f.events()).toEqual([]);
  }, 15000);
});
