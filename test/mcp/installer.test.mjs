import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { unzipSync } from "fflate";
import { afterAll, describe, expect, it } from "vitest";
import { zipDirectory } from "../../scripts/mcp/archive.mjs";
import {
  compareVersions,
  desktopHandoff,
  installInCodex,
  installLocalPlugin,
  sourceDigest,
} from "../../scripts/mcp/installer/install-core.mjs";
import {
  buildSetupRelease,
  setupPrompt,
} from "../../scripts/mcp/setup-release.mjs";

const mac = process.platform === "darwin" && process.arch === "arm64";
const roots = [];
const children = new Set();
it.skipIf(!mac)(
  "builds a local plugin page link without opening it or claiming installation",
  () => {
    const home = "/fictional A + B & # ? ' $() 雪";
    const result = desktopHandoff(
      { ok: true, runtime: "prepared", connection: "sign_in_required" },
      home,
    );
    const url = new URL(result.pluginPageUrl);
    expect(url.protocol).toBe("codex:");
    expect(url.hostname).toBe("plugins");
    expect(url.pathname).toBe("/flockbot-macos");
    expect(url.searchParams.size).toBe(1);
    expect(url.searchParams.get("marketplacePath")).toBe(
      join(home, ".agents/plugins/marketplace.json"),
    );
    expect(url.hash).toBe("");
    expect(result.pluginPageUrl).not.toContain(home);
    expect(result.pluginPageUrl).not.toMatch(/[\s'"$()]/);
    expect(result.host).toBe("manual_install_required");
    expect(result.remaining).toContain("host_install");
    expect(result.remaining).toContain("sign_in");
  },
);
afterAll(async () => {
  for (const root of roots) await rm(join(root, "gate"), { force: true });
  await delay(100);
  for (const child of children) child.kill("SIGKILL");
  await Promise.all(
    roots.map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await mkdtemp(
    join(await realpath(tmpdir()), "flockbot-installer-"),
  );
  roots.push(root);
  const home = join(root, "home"),
    plugin = join(root, "release plugin"),
    bin = join(root, "bin");
  await mkdir(home);
  await mkdir(bin);
  await cp("plugins/flockbot-macos", plugin, { recursive: true });
  // Update/refusal fixtures start from a fixed fictional release, independent
  // of the candidate version currently being packaged from the repository.
  await version({ plugin }, "0.2.0");
  const catalog = join(home, ".agents/plugins/marketplace.json");
  const connection = join(
    home,
    "Library/Application Support/Flockbot MCP/browser-v1",
  );
  await mkdir(join(connection, "browser"), { recursive: true });
  const sentinels = {
    "connection.json":
      '{"version":1,"generation":"fictional-generation","parish":"example-parish","userId":"fictional-id","state":"ready","future":"keep exact bytes"}\n',
    "broker.json": "fictional-broker-sentinel-do-not-read\n",
    "browser/session": "fictional-browser-session-sentinel\n",
  };
  for (const [name, bytes] of Object.entries(sentinels))
    await writeFile(join(connection, name), bytes, { mode: 0o600 });
  await mkdir(join(home, ".codex"));
  const config =
    '# fictional unrelated host configuration\n[other]\nunknown = "preserve"\n';
  await writeFile(join(home, ".codex/config.toml"), config, { mode: 0o640 });
  return { root, home, plugin, bin, catalog, connection, sentinels, config };
}
function install(f, options = {}) {
  return installLocalPlugin({ home: f.home, plugin: f.plugin, ...options });
}
async function saveCatalog(f, data) {
  await mkdir(join(f.home, ".agents/plugins"), { recursive: true });
  await writeFile(
    f.catalog,
    typeof data === "string" ? data : `${JSON.stringify(data)}\n`,
    { mode: 0o640 },
  );
}
async function untouched(f) {
  for (const [name, bytes] of Object.entries(f.sentinels))
    expect(await readFile(join(f.connection, name), "utf8")).toBe(bytes);
  expect(await readFile(join(f.home, ".codex/config.toml"), "utf8")).toBe(
    f.config,
  );
  expect((await stat(join(f.home, ".codex/config.toml"))).mode & 0o777).toBe(
    0o640,
  );
}
async function version(f, value) {
  const path = join(f.plugin, ".codex-plugin/plugin.json"),
    data = JSON.parse(await readFile(path, "utf8"));
  data.version = value;
  await writeFile(path, JSON.stringify(data));
  await writeFile(join(f.plugin, "runtime.version"), `${value}\n`);
}

describe.skipIf(!mac)("Mac installation core and filesystem", () => {
  it("preserves a custom personal name, unrelated entries, unknown fields and file mode; repeated setup changes no catalog/source bytes or mtime", async () => {
    const f = await fixture();
    const other = {
      name: "other",
      source: "./other",
      unknown: { future: [1, true] },
    };
    await saveCatalog(f, {
      name: "my-personal",
      interface: { displayName: "Mine", future: 7 },
      future: { preserve: true },
      plugins: [other],
    });
    const result = install(f);
    expect(result).toMatchObject({
      marketplace: "my-personal",
      connection: "saved_ready",
      authentication: "not_checked",
    });
    const first = await readFile(f.catalog),
      firstStat = await stat(f.catalog);
    expect(firstStat.mode & 0o777).toBe(0o640);
    const catalog = JSON.parse(first);
    expect(catalog.plugins[0]).toEqual(other);
    expect(catalog.future).toEqual({ preserve: true });
    expect(catalog.interface).toEqual({ displayName: "Mine", future: 7 });
    expect(install(f).source).toBe("reused");
    expect(await readFile(f.catalog)).toEqual(first);
    expect((await stat(f.catalog)).mtimeMs).toBe(firstStat.mtimeMs);
    expect(
      (await readdir(join(f.home, ".flockbot/sources"))).filter(
        (n) => n !== ".stages",
      ),
    ).toHaveLength(1);
    await untouched(f);
  });

  it("preserves unknown JSON numbers beyond JavaScript precision while merging", async () => {
    const f = await fixture();
    await saveCatalog(
      f,
      '{"name":"custom","plugins":[],"future":{"large":9007199254740993,"precise":1.0000000000000001,"huge":1e400,"negativeZero":-0}}',
    );
    install(f);
    const text = await readFile(f.catalog, "utf8");
    for (const numeric of [
      "9007199254740993",
      "1.0000000000000001",
      "1e400",
      "-0",
    ])
      expect(text).toContain(numeric);
    expect(install(f).source).toBe("reused");
    expect(await readFile(f.catalog, "utf8")).toBe(text);
  });

  it.each([
    ["{broken", "malformed_data"],
    ['{"name":"a","name":"b","plugins":[]}', "malformed_data"],
    [
      {
        name: "personal",
        plugins: [{ name: "duplicate" }, { name: "duplicate" }],
      },
      "duplicate_entry",
    ],
    [
      {
        name: "personal",
        plugins: [{ name: "flockbot-macos", source: "./foreign" }],
      },
      "ownership_conflict",
    ],
    [
      {
        name: "personal",
        plugins: [{ name: "renamed", source: "./.flockbot/sources/foreign" }],
      },
      "ownership_conflict",
    ],
    [
      {
        name: "personal",
        plugins: [{ name: "other", flockbot: { owner: "foreign" } }],
      },
      "ownership_conflict",
    ],
    [{ name: "bad@name", plugins: [] }, "malformed_data"],
  ])(
    "refuses ambiguous/foreign catalogs without replacing them (%j)",
    async (data, code) => {
      const f = await fixture();
      await saveCatalog(f, data);
      const before = await readFile(f.catalog);
      expect(() => install(f)).toThrow(code);
      expect(await readFile(f.catalog)).toEqual(before);
      await untouched(f);
    },
  );

  it.each(["catalog", "ancestor", "source", "payload"])(
    "rejects symlink %s without following it",
    async (kind) => {
      const f = await fixture();
      const outside = join(f.root, "outside");
      await mkdir(outside);
      if (kind === "catalog") {
        await saveCatalog(f, { name: "mine", plugins: [] });
        await rm(f.catalog);
        await writeFile(
          join(outside, "catalog"),
          '{"name":"outside","plugins":[]}',
        );
        await symlink(join(outside, "catalog"), f.catalog);
      }
      if (kind === "ancestor") await symlink(outside, join(f.home, ".agents"));
      if (kind === "source") {
        await mkdir(join(f.home, ".flockbot"));
        await symlink(outside, join(f.home, ".flockbot/sources"));
      }
      if (kind === "payload")
        await symlink(outside, join(f.plugin, "bad-link"));
      expect(() => install(f)).toThrow(/unsafe/);
      await untouched(f);
    },
  );

  it("refuses source collisions, damaged receipt, changed payload and incompatible ownership schema", async () => {
    for (const kind of ["collision", "receipt", "payload", "schema"]) {
      const f = await fixture();
      const digest = sourceDigest(f.plugin),
        target = join(f.home, ".flockbot/sources", `0.2.0-${digest}`);
      if (kind === "collision") {
        await mkdir(target, { recursive: true });
        await writeFile(join(target, "foreign"), "keep");
      } else {
        install(f);
        if (kind === "payload")
          await writeFile(join(target, "setup.sh"), "foreign mutation");
        else {
          const path = join(target, ".flockbot-source.json");
          const receipt = JSON.parse(await readFile(path));
          if (kind === "schema") receipt.schema = 2;
          else receipt.owner = "foreign";
          await writeFile(path, JSON.stringify(receipt));
        }
      }
      const before = await readFile(f.catalog).catch(() => null);
      expect(() => install(f)).toThrow(/ownership_conflict|source_changed/);
      expect(await readFile(f.catalog).catch(() => null)).toEqual(before);
      await untouched(f);
    }
  });

  it("retains old usable sources on update and rejects downgrades, same-version replacement and incompatible connection metadata", async () => {
    const f = await fixture();
    install(f);
    const old = JSON.parse(await readFile(f.catalog)).plugins[0].source.path;
    await version(f, "0.3.0-beta.0");
    expect(install(f).version).toBe("0.3.0-beta.0");
    expect(await readFile(join(f.home, old, "runtime.version"), "utf8")).toBe(
      "0.2.0\n",
    );
    const before = await readFile(f.catalog);
    await version(f, "0.2.0");
    expect(() => install(f)).toThrow("downgrade_rejected");
    await version(f, "0.3.0-beta.0");
    await writeFile(join(f.plugin, "new-file"), "same version different bytes");
    expect(() => install(f)).toThrow("version_collision");
    await version(f, "0.4.0");
    await writeFile(
      join(f.connection, "connection.json"),
      '{"version":2,"state":"ready"}',
    );
    expect(() => install(f)).toThrow("connection_incompatible");
    expect(await readFile(f.catalog)).toEqual(before);
  });
});

it.each([
  ["1.0.0", "1.0.0-rc.10", 1],
  ["1.0.0-rc.10", "1.0.0-rc.2", 1],
  ["1.0.0-alpha.1", "1.0.0-alpha", 1],
  ["1.0.0-1", "1.0.0-alpha", -1],
  ["0.2.0", "0.2.0", 0],
  ["9007199254740993.0.0", "9007199254740992.0.0", 1],
])("compares semantic versions safely (%s, %s)", (a, b, result) =>
  expect(compareVersions(a, b)).toBe(result),
);
it.each(["01.0.0", "1.0.0-01", "1.0.0+build", "../1.0.0"])(
  "rejects unsupported version %s",
  (v) => expect(() => compareVersions(v, "1.0.0")).toThrow("invalid_version"),
);

describe.skipIf(!mac)("Mac installation recovery and state", () => {
  it.each(["source_staged", "catalog_commit"])(
    "recovers an interrupted %s with the previous catalog still usable",
    async (point) => {
      const f = await fixture();
      install(f);
      const before = await readFile(f.catalog);
      await version(f, "0.3.0");
      expect(() =>
        install(f, {
          beforeCommit: (stage) => {
            if (stage === point) throw new Error("fixture interruption");
          },
        }),
      ).toThrow("fixture interruption");
      expect(await readFile(f.catalog)).toEqual(before);
      expect(install(f).version).toBe("0.3.0");
      await untouched(f);
    },
  );

  it("refuses a concurrent catalog edit after source staging, retaining the editor's exact bytes and prior payload", async () => {
    const f = await fixture();
    install(f);
    const old = JSON.parse(await readFile(f.catalog)).plugins[0].source.path;
    await version(f, "0.3.0");
    const { writeFileSync } = await import("node:fs");
    const external =
      '{"name":"concurrently-edited","plugins":[],"unknown":true}\n';
    expect(() =>
      install(f, {
        beforeCommit: (stage) => {
          if (stage === "catalog_commit") writeFileSync(f.catalog, external);
        },
      }),
    ).toThrow("concurrent_edit");
    expect(await readFile(f.catalog, "utf8")).toBe(external);
    expect(await readFile(join(f.home, old, "runtime.version"), "utf8")).toBe(
      "0.2.0\n",
    );
    await untouched(f);
  });

  it("preserves unknown fields on its owned entry and refuses unknown abandoned stages", async () => {
    const f = await fixture();
    install(f);
    const catalog = JSON.parse(await readFile(f.catalog));
    catalog.plugins[0].future = 42;
    catalog.plugins[0].source.future = 8;
    catalog.plugins[0].flockbot.future = 9;
    await saveCatalog(f, catalog);
    await version(f, "0.3.0");
    install(f);
    expect(JSON.parse(await readFile(f.catalog)).plugins[0]).toMatchObject({
      future: 42,
      source: { future: 8 },
      flockbot: { future: 9 },
    });
    await mkdir(join(f.home, ".flockbot/sources/.stages/foreign"));
    expect(() => install(f)).toThrow("ownership_conflict");
  });

  it("preserves foreign UUID stages, malformed intents and uncommitted intent files; adopts complete legacy markers", async () => {
    const { OWNER } = await import(
      "../../scripts/mcp/installer/install-core.mjs"
    );
    for (const kind of [
      "legacy",
      "foreign",
      "partial_intent",
      "orphan_temporary",
    ]) {
      const f = await fixture();
      install(f);
      const stages = join(f.home, ".flockbot/sources/.stages");
      const name = "11111111-1111-4111-8111-111111111111";
      const stage = join(stages, name);
      if (kind === "orphan_temporary") {
        const temporary = join(
          f.home,
          ".flockbot/sources/.stage-intent-foreign.pending",
        );
        await writeFile(temporary, "partial proof is not authority");
        expect(install(f).source).toBe("reused");
        expect(await readFile(temporary, "utf8")).toBe(
          "partial proof is not authority",
        );
        continue;
      }
      await mkdir(stage);
      await writeFile(
        join(stage, ".stage-owner"),
        kind === "legacy" ? OWNER : "foreign",
      );
      if (kind === "partial_intent")
        await writeFile(`${stage}.json`, '{"owner":');
      const before = await readFile(f.catalog);
      if (kind === "legacy") {
        expect(install(f).source).toBe("reused");
        expect(await readdir(stages)).toEqual([]);
      } else {
        expect(() => install(f)).toThrow(/ownership_conflict|malformed_data/);
        expect(await readFile(join(stage, ".stage-owner"), "utf8")).toBe(
          "foreign",
        );
      }
      expect(await readFile(f.catalog)).toEqual(before);
      await untouched(f);
    }
  });

  it("reports absent, pending and saved readiness without claiming a fresh authentication check", async () => {
    for (const state of [null, "pending", "ready", "action_required"]) {
      const f = await fixture();
      if (state)
        await writeFile(
          join(f.connection, "connection.json"),
          JSON.stringify({ version: 1, state }),
        );
      else await rm(join(f.connection, "connection.json"));
      expect(install(f)).toMatchObject({
        authentication: "not_checked",
        connection:
          state === "ready"
            ? "saved_ready"
            : state === "pending"
              ? "sign_in_pending"
              : "sign_in_required",
        host: "not_installed",
        remaining: [
          "runtime_prepare",
          "host_install",
          "host_reload",
          "check_saved_status",
        ],
      });
    }
  });

  it.each([
    "codex_missing",
    "codex_failed",
    "codex_unsupported",
    "host_source_conflict",
  ])(
    "returns safe bounded host failure %s with the prepared source retained",
    async (code) => {
      const f = await fixture(),
        result = install(f);
      const host = installInCodex(result, f.home, (args) => {
        if (code === "codex_missing" || code === "codex_failed")
          throw new Error("private CLI output with fictional secret");
        if (args[0] === "--version") return "codex-cli 0.166.0";
        if (code === "codex_unsupported") return "Old unsupported usage";
        if (args.includes("--help")) return "--json";
        return JSON.stringify({
          marketplaces: [
            { name: result.marketplace, root: "/fictional/foreign" },
          ],
        });
      });
      expect(host.ok).toBe(false);
      expect(host.code).toBe(code === "codex_missing" ? "codex_failed" : code);
      expect(JSON.stringify(host)).not.toContain("private CLI");
      expect(install(f).source).toBe("reused");
      await untouched(f);
    },
  );
});

async function fakeCodex(f, mode = "supported") {
  await writeFile(
    join(f.bin, "codex"),
    `#!${process.execPath}\nimport {appendFileSync,existsSync,readFileSync,writeFileSync} from 'node:fs';\nconst args=process.argv.slice(2), root=process.env.FIXTURE_ROOT, home=process.env.HOME;\nappendFileSync(root+'/cli-events',JSON.stringify(args)+'\\n');\nif (${JSON.stringify(mode)}==='failed') { console.error('fictional private host error'); process.exit(7); }\nif(args[0]==='--version') {console.log('codex-cli 0.166.0'); process.exit(0); }\nif(args.includes('--help')) { console.log(${JSON.stringify(mode === "unsupported" ? "old CLI" : "--json")}); process.exit(${mode === "unsupported" ? 2 : 0}); }\nif(args.join(' ')==='plugin marketplace list --json') console.log(JSON.stringify({marketplaces:existsSync(root+'/registered')?[{name:readFileSync(root+'/registered','utf8'),root:home}]:[]}));\nelse if(args.join(' ')==='plugin list --json') console.log(JSON.stringify({installed:existsSync(root+'/installed')?[JSON.parse(readFileSync(root+'/installed','utf8'))]:[]}));\nelse if(args[1]==='marketplace'&&args[2]==='add') { const name=JSON.parse(readFileSync(home+'/.agents/plugins/marketplace.json')).name; writeFileSync(root+'/registered',name); console.log(JSON.stringify({marketplaceName:name,installedRoot:home})); }\nelse if(args[1]==='add') { writeFileSync(root+'/entered','yes'); while(existsSync(root+'/gate')) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20); const [name,marketplaceName]=args[2].split('@'); writeFileSync(root+'/installed',JSON.stringify({name,marketplaceName,version:'local'})); console.log(JSON.stringify({name,marketplaceName,version:'local'})); }\nelse process.exit(9);\n`,
  );
  await chmod(join(f.bin, "codex"), 0o755);
}
function run(f, command, args, extra = {}) {
  const child = spawn(command, args, {
    env: {
      ...process.env,
      HOME: f.home,
      CODEX_HOME: join(f.home, ".codex"),
      FLOCKBOT_INSTALL_ROOT: join(f.home, "runtime"),
      FIXTURE_ROOT: f.root,
      PATH: `${f.bin}:/usr/bin:/bin`,
      ...extra,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (data) => {
    stdout += data;
  });
  child.stderr.on("data", (data) => {
    stderr += data;
  });
  return {
    child,
    done: new Promise((resolve) =>
      child.on("close", (code, signal) => {
        children.delete(child);
        resolve({ code, signal, stdout, stderr });
      }),
    ),
  };
}
async function waitFor(file) {
  for (let i = 0; i < 250; i++) {
    if (await stat(file).catch(() => null)) return;
    await delay(20);
  }
  throw new Error("Fixture did not reach the coordination gate");
}
describe.skipIf(!mac)(
  "native shared installation entry (fictional payload, no downloads/browser)",
  () => {
    it.each(["supported", "unsupported", "failed", "missing"])(
      "handles an actual %s fixture executable with disposable HOME/CODEX_HOME",
      async (mode) => {
        const f = await fixture();
        if (mode !== "missing") await fakeCodex(f, mode);
        const output = await run(f, process.execPath, [
          resolve("scripts/mcp/installer/install-core.mjs"),
          "--plugin",
          f.plugin,
        ]).done;
        const result = JSON.parse(output.stdout);
        expect(output.code).toBe(mode === "supported" ? 0 : 1);
        expect(result).toMatchObject(
          mode === "supported"
            ? { host: "reload_required", authentication: "not_checked" }
            : { code: `codex_${mode}`, host: "installation_required" },
        );
        expect(output.stdout).not.toContain("fictional private host error");
        await untouched(f);
      },
    );
    it("emits cause-specific repair actions for shell argument, runtime and coordination failures", async () => {
      const f = await fixture();
      const setup = join(f.root, "setup");
      await mkdir(join(setup, "plugin"), { recursive: true });
      await cp("scripts/mcp/installer/install.sh", join(setup, "install.sh"));
      await writeFile(join(setup, "plugin/setup.sh"), "#!/bin/bash\nexit 1\n");
      for (const [args, code, action] of [
        [["--bad"], "invalid_arguments", "correct_setup_arguments"],
        [
          [],
          "runtime_preparation_failed",
          "resolve_runtime_failure_then_retry",
        ],
      ]) {
        const output = await run(f, "/bin/bash", [
          join(setup, "install.sh"),
          ...args,
        ]).done;
        expect(output.code).toBe(1);
        expect(JSON.parse(output.stdout)).toMatchObject({
          ok: false,
          code,
          remaining: [action],
        });
      }
      await symlink(
        join(f.root, "foreign-lock"),
        join(f.home, ".flockbot-install.lock"),
      );
      const output = await run(f, process.execPath, [
        resolve("scripts/mcp/installer/install-core.mjs"),
        "--plugin",
        f.plugin,
      ]).done;
      expect(output.code).toBe(1);
      expect(JSON.parse(output.stdout)).toEqual({
        schema: 1,
        ok: false,
        code: "coordination_failed",
        remaining: ["resolve_coordination_then_retry"],
      });
      await untouched(f);
    });
    it.each([
      ["downgrade_rejected", "use_current_or_newer_release"],
      ["version_collision", "obtain_matching_release"],
      ["ownership_conflict", "reconcile_ownership_conflict"],
      ["connection_incompatible", "use_compatible_release"],
      ["malformed_data", "repair_malformed_data"],
      ["source_changed", "restore_verified_source"],
    ])(
      "emits bounded JSON and a specific repair action for %s",
      async (code, action) => {
        const f = await fixture();
        install(f);
        const catalog = JSON.parse(await readFile(f.catalog));
        if (code === "downgrade_rejected") await version(f, "0.1.0");
        if (code === "version_collision")
          await writeFile(join(f.plugin, "changed"), "fixture");
        if (code === "ownership_conflict") {
          catalog.plugins[0].flockbot.owner = "foreign";
          await saveCatalog(f, catalog);
        }
        if (code === "connection_incompatible") {
          await writeFile(
            join(f.connection, "connection.json"),
            '{"version":2,"state":"ready"}',
          );
          f.sentinels["connection.json"] = '{"version":2,"state":"ready"}';
        }
        if (code === "malformed_data") await saveCatalog(f, "{broken");
        if (code === "source_changed")
          await writeFile(
            join(f.home, catalog.plugins[0].source.path, "setup.sh"),
            "changed fixture source",
          );
        const before = await readFile(f.catalog);
        const output = await run(f, process.execPath, [
          resolve("scripts/mcp/installer/install-core.mjs"),
          "--plugin",
          f.plugin,
        ]).done;
        expect(output.code).toBe(1);
        const result = JSON.parse(output.stdout);
        expect(result).toMatchObject({
          schema: 1,
          ok: false,
          code,
          requestedVersion: code === "downgrade_rejected" ? "0.1.0" : "0.2.0",
          runtime: "preparation_required",
          host: "not_checked",
          authentication: "not_checked",
          remaining: [action],
        });
        if (
          [
            "downgrade_rejected",
            "version_collision",
            "connection_incompatible",
          ].includes(code)
        ) {
          expect(result.installedVersion).toBe("0.2.0");
          expect(result.source).toBe("retained");
          expect(result.connection).toBe(
            code === "connection_incompatible" ? "unrecognized" : "saved_ready",
          );
        } else expect(result).not.toHaveProperty("installedVersion");
        expect(output.stdout).not.toContain(f.home);
        expect(output.stdout).not.toMatch(
          /fictional-generation|example-parish|broker-sentinel/,
        );
        expect(await readFile(f.catalog)).toEqual(before);
        await untouched(f);
      },
    );
    it.each([
      "stage_intent",
      "stage_created",
      "partial_marker",
      "stage_cleanup_entry",
      "stage_cleanup_empty",
      "stage_removed",
    ])(
      "recovers after SIGKILL at %s with durable ownership and the previous source intact",
      async (point) => {
        const f = await fixture();
        install(f);
        const catalog = await readFile(f.catalog);
        const old = JSON.parse(catalog).plugins[0].source.path;
        await version(f, "0.3.0");
        const driver = `import {installLocalPlugin} from ${JSON.stringify(resolve("scripts/mcp/installer/install-core.mjs"))};
        import {readdirSync,writeFileSync} from 'node:fs';
        const stages=${JSON.stringify(join(f.home, ".flockbot/sources/.stages"))};
        installLocalPlugin({home:${JSON.stringify(f.home)},plugin:${JSON.stringify(f.plugin)},beforeCommit(boundary){
          if(boundary!==${JSON.stringify(point === "partial_marker" ? "stage_created" : point)}) return;
          if(${JSON.stringify(point)}==='partial_marker') writeFileSync(stages+'/'+readdirSync(stages).find(n=>!n.endsWith('.json'))+'/.stage-owner','org.ask');
          writeFileSync(${JSON.stringify(join(f.root, "interrupted"))},boundary);
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);
        }});`;
        const child = run(f, process.execPath, [
          "--input-type=module",
          "-e",
          driver,
        ]);
        await waitFor(join(f.root, "interrupted"));
        child.child.kill("SIGKILL");
        expect((await child.done).signal).toBe("SIGKILL");
        const stages = join(f.home, ".flockbot/sources/.stages");
        expect(
          (await readdir(stages)).filter((n) => n.endsWith(".json")),
        ).toHaveLength(1);
        expect(await readFile(f.catalog)).toEqual(catalog);
        expect(
          await readFile(join(f.home, old, "runtime.version"), "utf8"),
        ).toBe("0.2.0\n");
        expect(install(f).version).toBe("0.3.0");
        expect(await readdir(stages)).toEqual([]);
        await untouched(f);
      },
    );
    it("serializes processes and retains the OS lock across a killed parent until active child host work finishes", async () => {
      const f = await fixture();
      await fakeCodex(f);
      await writeFile(join(f.root, "gate"), "hold");
      const args = [
        resolve("scripts/mcp/installer/install-core.mjs"),
        "--plugin",
        f.plugin,
      ];
      const first = run(f, process.execPath, args);
      await waitFor(join(f.root, "entered"));
      first.child.kill("SIGKILL");
      const before = await readFile(join(f.root, "cli-events"), "utf8");
      const second = run(f, process.execPath, args);
      await delay(300);
      expect(await readFile(join(f.root, "cli-events"), "utf8")).toBe(before);
      await rm(join(f.root, "gate"));
      expect((await second.done).code).toBe(0);
      await first.done;
      await untouched(f);
    }, 10000);
    it("runs both logical routes through the distributed entry, preserving exact connection, browser, broker and unrelated config bytes", async () => {
      const f = await fixture();
      const payload = join(f.root, "runtime-payload");
      await mkdir(join(payload, "server"), { recursive: true });
      await mkdir(join(payload, "node_modules/playwright"), {
        recursive: true,
      });
      await writeFile(
        join(payload, "node"),
        `#!/bin/bash\nexec '${process.execPath.replaceAll("'", "'\\''")}' "$@"\n`,
      );
      await chmod(join(payload, "node"), 0o755);
      await writeFile(
        join(payload, "server/index.mjs"),
        "// fictional server; never contacts a service\n",
      );
      await writeFile(
        join(payload, "node_modules/playwright/cli.js"),
        "// fictional browser preparation\n",
      );
      await writeFile(
        join(payload, "setup-browser.mjs"),
        "// fictional browser fixture; no download\n",
      );
      await writeFile(
        join(payload, "package.json"),
        '{"name":"flockbot-local-runtime","version":"0.2.0","private":true,"type":"module"}\n',
      );
      for (const name of ["install-core.mjs", "install-lock.sh"])
        await cp(join("scripts/mcp/installer", name), join(payload, name));
      const runtime = join(f.root, "runtime.zip");
      await zipDirectory(payload, runtime);
      await writeFile(
        join(f.plugin, "runtime.sha256"),
        `${createHash("sha256")
          .update(await readFile(runtime))
          .digest("hex")}\n`,
      );
      const stage = join(f.root, "setup"),
        out = join(f.root, "artifacts");
      await mkdir(out);
      const artifacts = await buildSetupRelease({
        stage,
        out,
        version: "0.2.0",
        runtime,
        plugin: f.plugin,
      });
      const zip = unzipSync(await readFile(join(out, artifacts[0].filename)));
      expect(zip["runtime.zip"]).toBeDefined();
      expect(zip["plugin/assets/flockbot.svg"]).toBeDefined();
      expect(
        Object.keys(zip).some((name) =>
          /browser-v1|broker.json|connection.json/.test(name),
        ),
      ).toBe(false);
      for (const route of ["desktop", "tui", "desktop"]) {
        const before = await readFile(join(f.root, "cli-events")).catch(
          () => null,
        );
        if (route === "tui") await fakeCodex(f);
        const output = await run(f, "/bin/bash", [
          join(stage, "install.sh"),
          "--route",
          route,
        ]).done;
        expect(output.code, output.stderr).toBe(0);
        expect(JSON.parse(output.stdout)).toMatchObject({
          version: "0.2.0",
          host:
            route === "desktop" ? "manual_install_required" : "reload_required",
          connection: "saved_ready",
        });
        if (route === "desktop") {
          const page = new URL(JSON.parse(output.stdout).pluginPageUrl);
          expect(page.protocol).toBe("codex:");
          expect(page.hostname).toBe("plugins");
          expect(page.pathname).toBe("/flockbot-macos");
          expect(page.searchParams.get("marketplacePath")).toBe(f.catalog);
          expect(
            await readFile(join(f.root, "cli-events")).catch(() => null),
          ).toEqual(before);
        }
        await untouched(f);
      }
      const prompt = await readFile(join(out, artifacts[1].filename), "utf8");
      const block = prompt.match(/```sh\n([\s\S]*?)```/)[1];
      // Keep prompt-created directories observable and owned by this fixture.
      // BSD mktemp without a template need not use the injected TMPDIR.
      await writeFile(
        join(f.bin, "mktemp"),
        '#!/bin/bash\nif [[ $# == 1 && "$1" == -d ]]; then exec /usr/bin/mktemp -d "$FIXTURE_ROOT/prompt.XXXXXX"; fi\nexec /usr/bin/mktemp "$@"\n',
      );
      await chmod(join(f.bin, "mktemp"), 0o755);
      await writeFile(
        join(f.bin, "curl"),
        '#!/bin/bash\nprintf "%s\\n" "$@" >> "$FIXTURE_ROOT/downloads"\nwhile [[ $# -gt 0 ]]; do if [[ "$1" == --output ]]; then cp "$FIXTURE_DOWNLOAD" "$2"; exit; fi; shift; done\nexit 1\n',
      );
      await chmod(join(f.bin, "curl"), 0o755);
      const download = join(out, artifacts[0].filename);
      const promptRun = await run(f, "/bin/bash", ["-c", block], {
        FIXTURE_DOWNLOAD: download,
        TMPDIR: f.root,
      }).done;
      expect(promptRun.code, `${promptRun.stderr} ${promptRun.stdout}`).toBe(0);
      expect(promptRun.stdout).toContain('"host":"manual_install_required"');
      const terminalPrompt = block.replace("--route desktop", "--route tui");
      const terminalRun = await run(f, "/bin/bash", ["-c", terminalPrompt], {
        FIXTURE_DOWNLOAD: download,
        TMPDIR: f.root,
      }).done;
      expect(terminalRun.code, terminalRun.stderr).toBe(0);
      expect(terminalRun.stdout).toContain('"host":"reload_required"');
      await untouched(f);
      const beforeBadDownload = await readFile(join(f.root, "cli-events"));
      const corrupt = join(f.root, "tampered.zip");
      const canary = join(f.root, "tampered-payload");
      await mkdir(canary);
      await writeFile(join(canary, "must-not-extract"), "fictional canary\n");
      await zipDirectory(canary, corrupt);
      const promptTemps = await readdir(f.root);
      const rejected = await run(f, "/bin/bash", ["-c", block], {
        FIXTURE_DOWNLOAD: corrupt,
        TMPDIR: f.root,
      }).done;
      expect(rejected.code).not.toBe(0);
      // A valid-but-wrong ZIP would extract successfully without the checksum.
      const newTemps = (await readdir(f.root)).filter(
        (name) => !promptTemps.includes(name),
      );
      expect(newTemps).toHaveLength(1);
      await expect(
        stat(join(f.root, newTemps[0], "payload")),
      ).rejects.toThrow();
      expect(await readFile(join(f.root, "cli-events"))).toEqual(
        beforeBadDownload,
      );
      await untouched(f);
      expect(
        JSON.parse(await readFile(f.catalog)).plugins.filter(
          (entry) => entry.name === "flockbot-macos",
        ),
      ).toHaveLength(1);
      const events = (await readFile(join(f.root, "cli-events"), "utf8"))
        .trim()
        .split("\n")
        .map(JSON.parse);
      expect(
        events.filter(
          (args) =>
            args[1] === "marketplace" &&
            args[2] === "add" &&
            !args.includes("--help"),
        ),
      ).toHaveLength(1);
      expect(
        events.filter((args) => args[1] === "add" && !args.includes("--help")),
      ).toHaveLength(1);
      // A newer release switches source using the other caller label, while
      // both the old source and the exact shared connection remain intact.
      const oldSource = JSON.parse(await readFile(f.catalog)).plugins[0].source
        .path;
      await version(f, "0.3.0");
      await writeFile(
        join(payload, "package.json"),
        '{"name":"flockbot-local-runtime","version":"0.3.0","private":true,"type":"module"}\n',
      );
      await zipDirectory(payload, runtime);
      await writeFile(
        join(f.plugin, "runtime.sha256"),
        `${createHash("sha256")
          .update(await readFile(runtime))
          .digest("hex")}\n`,
      );
      const updateStage = join(f.root, "update");
      await buildSetupRelease({
        stage: updateStage,
        out,
        version: "0.3.0",
        runtime,
        plugin: f.plugin,
      });
      const updated = await run(f, "/bin/bash", [
        join(updateStage, "install.sh"),
        "--route",
        "tui",
      ]).done;
      expect(updated.code, updated.stderr).toBe(0);
      expect(JSON.parse(updated.stdout)).toMatchObject({
        version: "0.3.0",
        runtime: "prepared",
        connection: "saved_ready",
      });
      expect(
        await readFile(join(f.home, oldSource, "runtime.version"), "utf8"),
      ).toBe("0.2.0\n");
      await untouched(f);
      const downgrade = await run(f, "/bin/bash", [
        join(stage, "install.sh"),
        "--route",
        "desktop",
      ]).done;
      expect(downgrade.code).toBe(1);
      expect(JSON.parse(downgrade.stdout)).toMatchObject({
        code: "downgrade_rejected",
        requestedVersion: "0.2.0",
        installedVersion: "0.3.0",
        source: "retained",
        runtime: "prepared",
        connection: "saved_ready",
        host: "not_checked",
        remaining: ["use_current_or_newer_release"],
      });
      const oldPrompt = await run(f, "/bin/bash", ["-c", block], {
        FIXTURE_DOWNLOAD: download,
        TMPDIR: f.root,
      }).done;
      expect(oldPrompt.code).toBe(1);
      expect(
        JSON.parse(oldPrompt.stdout.trim().split("\n").at(-1)),
      ).toMatchObject({
        code: "downgrade_rejected",
        requestedVersion: "0.2.0",
        installedVersion: "0.3.0",
        connection: "saved_ready",
        remaining: ["use_current_or_newer_release"],
      });
      await untouched(f);
    }, 10000);
  },
);

it.skipIf(!mac)(
  "reinstalls after host removal and refuses alternate-name roots and incompatible host receipts",
  async () => {
    const f = await fixture(),
      result = install(f);
    const market = { name: result.marketplace, root: f.home };
    let installed = false,
      calls = 0;
    const run = (args) => {
      if (args[0] === "--version") return "codex-cli 0.166.0";
      if (args.includes("--help")) return "--json";
      if (args[1] === "marketplace")
        return JSON.stringify({ marketplaces: [market] });
      if (args[1] === "list")
        return JSON.stringify({
          installed: installed
            ? [{ name: result.plugin, marketplaceName: result.marketplace }]
            : [],
        });
      calls++;
      installed = true;
      return JSON.stringify({
        name: result.plugin,
        marketplaceName: result.marketplace,
      });
    };
    expect(installInCodex(result, f.home, run).ok).toBe(true);
    expect(installInCodex(result, f.home, run).ok).toBe(true);
    expect(calls).toBe(1);
    installed = false;
    expect(installInCodex(result, f.home, run).ok).toBe(true);
    expect(calls).toBe(2);
    market.name = "conflicting-old-name";
    expect(installInCodex(result, f.home, run).code).toBe(
      "host_source_conflict",
    );
    market.name = result.marketplace;
    const hosts = join(f.home, ".flockbot/hosts"),
      receipt = join(hosts, (await readdir(hosts))[0]);
    await writeFile(receipt, '{"owner":"foreign","schema":2}');
    expect(installInCodex(result, f.home, run).code).toBe("ownership_conflict");
    await untouched(f);
  },
);

it("generates the fixed release URL/version/digest outside the hashed payload; validates branding/assets and rejects arbitrary metadata", async () => {
  const f = await fixture(),
    runtime = join(f.root, "runtime.zip"),
    out = join(f.root, "out");
  await mkdir(out);
  await writeFile(runtime, "fictional-runtime");
  await writeFile(
    join(f.plugin, "runtime.sha256"),
    `${createHash("sha256")
      .update(await readFile(runtime))
      .digest("hex")}\n`,
  );
  const artifacts = await buildSetupRelease({
    stage: join(f.root, "stage"),
    out,
    version: "0.2.0",
    runtime,
    plugin: f.plugin,
  });
  const [archive, prompt] = artifacts;
  const bytes = await readFile(join(out, archive.filename));
  const text = await readFile(join(out, prompt.filename), "utf8");
  expect(archive.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
  expect(text).toContain(archive.sha256);
  expect(text).toContain(
    `https://github.com/askmyparish/flockbot/releases/download/mcp-v0.2.0/${archive.filename}`,
  );
  expect(text).toContain("--route tui");
  expect(text.indexOf("shasum -a 256 -c -")).toBeLessThan(
    text.indexOf("unzip -q"),
  );
  expect(text.indexOf("shasum -a 256 -c -")).toBeLessThan(
    text.indexOf("/bin/bash payload/install.sh"),
  );
  expect(text).not.toMatch(/curl[^\n]*\|\s*(sh|bash)/);
  const zip = unzipSync(bytes);
  expect(
    Object.keys(zip).some(
      (name) => name.endsWith(".md") && name.includes("flockbot-setup-"),
    ),
  ).toBe(false);
  const manifest = JSON.parse(
    Buffer.from(zip["plugin/.codex-plugin/plugin.json"]).toString(),
  );
  expect(manifest.author.name).toBe("AskMyParish");
  expect(manifest.author.url).toBe("https://askmyparish.com");
  expect(manifest.interface.websiteURL).toBe("https://askmyparish.com");
  expect(manifest.interface.longDescription).toContain("Not affiliated");
  expect(zip[`plugin/${manifest.interface.logo.slice(2)}`]).toBeDefined();
  expect(() =>
    setupPrompt({
      version: "0.2.0",
      filename: "https://evil.invalid/script",
      sha256: archive.sha256,
    }),
  ).toThrow();
});

it.each(["macos", "windows"])(
  "pins the supported %s compatibility manifest identity and onboarding shape",
  async (platform) => {
    const manifest = JSON.parse(
      await readFile(
        `plugins/flockbot-${platform}/.codex-plugin/plugin.json`,
        "utf8",
      ),
    );
    expect(Object.keys(manifest).sort()).toEqual(
      [
        "author",
        "description",
        "interface",
        "license",
        "mcpServers",
        "name",
        "onboardingSkill",
        "requires_local_executor",
        "skills",
        "version",
      ].sort(),
    );
    expect(manifest.onboardingSkill).toBe("./skills/setup/SKILL.md");
    expect(manifest.interface.developerName).toBe("AskMyParish");
    expect(manifest.interface.displayName).toBe("Flockbot");
    expect(manifest.author.url).toBe("https://askmyparish.com");
    expect(manifest.interface.websiteURL).toBe("https://askmyparish.com");
    expect(manifest.interface.longDescription).toContain(
      "Not affiliated with, endorsed by or supported by Flocknote",
    );
    expect(manifest.interface.logo).toBe("./assets/flockbot.svg");
    expect(manifest.interface.composerIcon).toBe(manifest.interface.logo);
    expect(
      await readFile(`plugins/flockbot-${platform}/assets/flockbot.svg`),
    ).toEqual(await readFile("assets/flockbot.svg"));
  },
);
