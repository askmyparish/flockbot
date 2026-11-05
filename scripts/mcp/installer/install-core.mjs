import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  cpSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export const OWNER = "org.askmyparish.flockbot.local-plugin";
const NAME = "flockbot-macos";
const RECEIPT = ".flockbot-source.json";
const safeName = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/;
class InstallError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
function requireState(value, code = "incompatible_state") {
  if (!value) throw new InstallError(code);
}
function info(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
export function directPath(path) {
  const absolute = resolve(path);
  let current = sep;
  for (const part of absolute.split(sep).filter(Boolean)) {
    current = join(current, part);
    const details = info(current);
    requireState(
      !details ||
        (!details.isSymbolicLink() &&
          (current === absolute || details.isDirectory())),
      "unsafe_path",
    );
  }
  return absolute;
}
function read(path, limit = 1024 * 1024) {
  directPath(path);
  const details = info(path);
  if (!details) return null;
  requireState(
    details.isFile() &&
      details.nlink === 1 &&
      details.size <= limit &&
      (!process.getuid || details.uid === process.getuid()),
    "unsafe_path",
  );
  return {
    bytes: readFileSync(path),
    mode: details.mode & 0o777,
    ino: details.ino,
    dev: details.dev,
  };
}
function json(bytes) {
  try {
    const text = String(bytes),
      value = JSON.parse(text, (_key, value, context) =>
        // Preserve unfamiliar numeric metadata (including integers beyond JS
        // precision) without a dependency or a lossy parse/stringify roundtrip.
        typeof value === "number" && JSON.stringify(value) !== context.source
          ? JSON.rawJSON(context.source)
          : value,
      );
    // JSON.parse silently accepts duplicate keys. Reject ambiguity even in
    // unknown metadata rather than normalizing somebody else's catalog.
    const tokens = text.match(
      /"(?:[^"\\]|\\.)*"|[{}[\]:,]|true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g,
    );
    let at = 0;
    function scan() {
      const token = tokens[at++];
      if (token === "{") {
        const keys = new Set();
        while (tokens[at] !== "}") {
          const key = JSON.parse(tokens[at++]);
          requireState(!keys.has(key), "malformed_data");
          keys.add(key);
          at++;
          scan();
          if (tokens[at] !== ",") break;
          at++;
        }
        at++;
      } else if (token === "[") {
        while (tokens[at] !== "]") {
          scan();
          if (tokens[at] !== ",") break;
          at++;
        }
        at++;
      }
    }
    scan();
    return value;
  } catch {
    throw new InstallError("malformed_data");
  }
}
function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function same(before, after) {
  return before === null
    ? after === null
    : after !== null &&
        before.bytes.equals(after.bytes) &&
        before.mode === after.mode &&
        before.ino === after.ino &&
        before.dev === after.dev;
}
export function compareVersions(a, b) {
  const parse = (v) => {
    requireState(
      typeof v === "string" &&
        v.length <= 100 &&
        /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.test(
          v,
        ),
      "invalid_version",
    );
    const [release, pre] = v.split(/-(.*)/s);
    const ids = pre?.split(".");
    requireState(
      !ids?.some((id) => /^\d+$/.test(id) && id.length > 1 && id[0] === "0"),
      "invalid_version",
    );
    return [release.split(".").map(BigInt), ids];
  };
  const [ar, ap] = parse(a),
    [br, bp] = parse(b);
  for (let i = 0; i < 3; i++)
    if (ar[i] !== br[i]) return ar[i] > br[i] ? 1 : -1;
  if (!ap || !bp) return ap === bp ? 0 : ap ? -1 : 1;
  for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
    if (ap[i] === bp[i]) continue;
    if (ap[i] === undefined || bp[i] === undefined)
      return ap[i] === undefined ? -1 : 1;
    const an = /^\d+$/.test(ap[i]),
      bn = /^\d+$/.test(bp[i]);
    if (an !== bn) return an ? -1 : 1;
    if (an) return BigInt(ap[i]) > BigInt(bp[i]) ? 1 : -1;
    return ap[i] > bp[i] ? 1 : -1;
  }
  return 0;
}
// Length-framed tree identity is installation ownership evidence, not an archive
// checksum. Exclude only the receipt itself. Reject links/devices/hardlinks.
export function sourceDigest(root) {
  directPath(root);
  const digest = createHash("sha256");
  function walk(folder) {
    for (const name of readdirSync(folder).sort()) {
      if (folder === root && name === RECEIPT) continue;
      const path = join(folder, name),
        details = lstatSync(path);
      requireState(
        !details.isSymbolicLink() &&
          (details.isDirectory() || (details.isFile() && details.nlink === 1)),
        "unsafe_source",
      );
      for (const part of [
        relative(root, path),
        details.isDirectory() ? "directory" : "file",
        String(
          details.isDirectory() ? 0 : Number(Boolean(details.mode & 0o111)),
        ),
        details.isFile() ? readFileSync(path) : Buffer.alloc(0),
      ]) {
        const bytes = Buffer.from(part);
        digest.update(`${bytes.length}:`);
        digest.update(bytes);
      }
      if (details.isDirectory()) walk(path);
    }
  }
  walk(root);
  return digest.digest("hex");
}
function compatibility(receipt) {
  requireState(
    object(receipt) &&
      receipt.owner === OWNER &&
      receipt.schema === 1 &&
      receipt.connectionSchema === "browser-v1" &&
      receipt.brokerProtocol === 1 &&
      receipt.runtimeFamily === "node22",
    "ownership_conflict",
  );
  compareVersions(receipt.version, receipt.version);
  requireState(/^[a-f0-9]{64}$/.test(receipt.digest), "ownership_conflict");
}
function sourceReceipt(path) {
  const snapshot = read(join(path, RECEIPT), 4096);
  requireState(snapshot, "ownership_conflict");
  const receipt = json(snapshot.bytes);
  compatibility(receipt);
  requireState(sourceDigest(path) === receipt.digest, "source_changed");
  return receipt;
}
function savedConnection(home) {
  // Inspect only bounded nonsecret metadata. Never open browser files or broker
  // descriptors (which contain an IPC key), and never write/migrate this tree.
  const metadata = read(
    join(
      home,
      "Library/Application Support/Flockbot MCP/browser-v1/connection.json",
    ),
    8192,
  );
  if (!metadata) return "sign_in_required";
  const value = json(metadata.bytes);
  requireState(
    object(value) &&
      value.version === 1 &&
      ["ready", "pending", "action_required"].includes(value.state),
    "connection_incompatible",
  );
  return value.state === "ready"
    ? "saved_ready"
    : value.state === "pending"
      ? "sign_in_pending"
      : "sign_in_required";
}
function catalogSnapshot(file) {
  const snapshot = read(file);
  const catalog = snapshot
    ? json(snapshot.bytes)
    : {
        name: "flockbot-personal",
        interface: { displayName: "Personal plugins" },
        plugins: [],
      };
  requireState(
    object(catalog) &&
      safeName.test(catalog.name) &&
      Array.isArray(catalog.plugins),
    "malformed_data",
  );
  const names = new Set();
  for (const entry of catalog.plugins) {
    requireState(
      object(entry) && typeof entry.name === "string" && !names.has(entry.name),
      "duplicate_entry",
    );
    names.add(entry.name);
  }
  return { snapshot, catalog };
}
function sourcePath(entry) {
  return typeof entry.source === "string" ? entry.source : entry.source?.path;
}
// Directory entries are synced around the intent lifecycle. The sidecar becomes
// durable before mkdir, and survives every recursive-removal boundary. A partial
// temporary intent is never ownership evidence and is left alone after a crash.
function syncDirectory(path) {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function stageIntent(stages, name) {
  const intent = join(stages, `${name}.json`);
  const temporary = join(
    dirname(stages),
    `.stage-intent-${randomUUID()}.pending`,
  );
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify({ owner: OWNER, schema: 1, stage: name }));
    fsyncSync(fd);
    requireState(!info(intent), "ownership_conflict");
    renameSync(temporary, intent);
    syncDirectory(stages);
  } finally {
    closeSync(fd);
    if (existsSync(temporary)) rmSync(temporary);
  }
}
function cleanStage(stages, name, boundary) {
  const stage = join(stages, name);
  if (info(stage)) {
    requireState(
      info(stage).isDirectory() && !info(stage).isSymbolicLink(),
      "ownership_conflict",
    );
    sourceDigest(stage); // Refuse links/devices, even with a valid intent.
    for (const entry of readdirSync(stage)) {
      rmSync(join(stage, entry), { recursive: true });
      boundary("stage_cleanup_entry");
    }
    boundary("stage_cleanup_empty");
    rmSync(stage, { recursive: true });
  }
  syncDirectory(stages);
  boundary("stage_removed");
  rmSync(join(stages, `${name}.json`));
  syncDirectory(stages);
}
function recoverStages(stages, boundary) {
  const names = readdirSync(stages);
  const owned = new Set();
  for (const name of names.filter((name) => name.endsWith(".json"))) {
    const snapshot = read(join(stages, name), 1024);
    const intent = snapshot && json(snapshot.bytes);
    requireState(
      object(intent) &&
        intent.owner === OWNER &&
        intent.schema === 1 &&
        typeof intent.stage === "string" &&
        /^[a-f0-9-]{36}$/.test(intent.stage) &&
        name === `${intent.stage}.json`,
      "ownership_conflict",
    );
    owned.add(intent.stage);
  }
  for (const name of names.filter((name) => !name.endsWith(".json"))) {
    if (owned.has(name)) continue;
    // Adopt only a complete legacy marker before cleanup. A filename alone
    // never authorizes removal, including a UUID-shaped foreign directory.
    const stage = join(stages, name);
    requireState(
      info(stage)?.isDirectory() &&
        !info(stage).isSymbolicLink() &&
        /^[a-f0-9-]{36}$/.test(name),
      "ownership_conflict",
    );
    const marker = read(join(stage, ".stage-owner"), 256);
    requireState(marker?.bytes.toString() === OWNER, "ownership_conflict");
    sourceDigest(stage);
    stageIntent(stages, name);
    owned.add(name);
  }
  for (const name of owned) cleanStage(stages, name, boundary);
}
const failureActions = {
  downgrade_rejected: "use_current_or_newer_release",
  version_collision: "obtain_matching_release",
  ownership_conflict: "reconcile_ownership_conflict",
  duplicate_entry: "reconcile_ownership_conflict",
  connection_incompatible: "use_compatible_release",
  malformed_data: "repair_malformed_data",
  source_changed: "restore_verified_source",
  unsafe_path: "resolve_unsafe_path",
  unsafe_source: "resolve_unsafe_path",
  concurrent_edit: "finish_other_writer_then_retry",
  invalid_version: "obtain_valid_release",
  invalid_package: "obtain_valid_release",
  invalid_arguments: "correct_setup_arguments",
  coordination_failed: "resolve_coordination_then_retry",
  codex_missing: "install_codex_then_retry",
  codex_unsupported: "update_codex_then_retry",
  codex_failed: "resolve_host_failure_then_retry",
  host_source_conflict: "reconcile_host_source_then_retry",
};
function failureResult(error, state, fallback = "installation_failed") {
  const code = error instanceof InstallError ? error.code : fallback;
  return {
    schema: 1,
    ...state,
    ok: false,
    code,
    remaining: [failureActions[code] ?? "resolve_failure_then_retry"],
  };
}
export function installLocalPlugin({
  home,
  plugin,
  installRoot = join(home, "Library/Application Support/Flockbot MCP"),
  beforeCommit = () => {},
  state = {},
}) {
  Object.assign(state, {
    source: "not_prepared",
    host: "not_checked",
    authentication: "not_checked",
  });
  home = directPath(home);
  plugin = directPath(plugin);
  const manifest = json(read(join(plugin, ".codex-plugin/plugin.json")).bytes);
  requireState(manifest.name === NAME, "invalid_package");
  const version = read(join(plugin, "runtime.version"), 128)
    ?.bytes.toString()
    .trim();
  requireState(
    compareVersions(version, manifest.version) === 0,
    "invalid_package",
  );
  state.requestedVersion = version;
  const runtimeDigest = read(join(plugin, "runtime.sha256"), 128)
    ?.bytes.toString()
    .trim();
  requireState(/^[a-f0-9]{64}$/.test(runtimeDigest), "invalid_package");
  requireState(!info(join(plugin, RECEIPT)), "invalid_package");
  const runtimeRoot = directPath(
    resolve(
      installRoot,
      "runtimes",
      `${version}-darwin-arm64-${runtimeDigest.slice(0, 12)}`,
    ),
  );
  const completed = read(join(runtimeRoot, ".complete"), 256);
  const identity = `flockbot-runtime-v1:${version}:darwin-arm64:${runtimeDigest}`;
  const runtime =
    completed &&
    ["", identity].includes(completed.bytes.toString().trim()) &&
    [
      "node",
      "server/index.mjs",
      "setup-browser.mjs",
      "node_modules/playwright/cli.js",
    ].every((name) => info(join(runtimeRoot, name))?.isFile())
      ? "prepared"
      : "preparation_required";
  state.runtime = runtime;
  const digest = sourceDigest(plugin);
  const root = join(home, ".flockbot", "sources");
  const target = join(root, `${version}-${digest}`);
  const path = `./${relative(home, target).split(sep).join("/")}`;
  const file = join(home, ".agents/plugins/marketplace.json");
  directPath(target);
  directPath(file);
  const { snapshot, catalog } = catalogSnapshot(file);
  const current = catalog.plugins.find((entry) => entry.name === NAME);
  for (const entry of catalog.plugins) {
    if (entry === current) continue;
    const candidate = sourcePath(entry);
    requireState(
      !entry.flockbot &&
        !(
          typeof candidate === "string" &&
          resolve(home, candidate).startsWith(`${root}${sep}`)
        ),
      "ownership_conflict",
    );
  }
  let old;
  if (current) {
    requireState(
      object(current.flockbot) &&
        current.flockbot.owner === OWNER &&
        current.flockbot.schema === 1,
      "ownership_conflict",
    );
    const oldPath = sourcePath(current);
    requireState(
      typeof oldPath === "string" &&
        oldPath.startsWith("./.flockbot/sources/") &&
        resolve(home, oldPath).startsWith(`${root}${sep}`),
      "ownership_conflict",
    );
    requireState(
      object(current.source) && current.source.source === "local",
      "ownership_conflict",
    );
    old = sourceReceipt(resolve(home, oldPath));
    Object.assign(state, { installedVersion: old.version, source: "retained" });
  }
  state.connection = "unrecognized";
  const connection = savedConnection(home);
  state.connection = connection;
  if (old) {
    requireState(
      compareVersions(version, old.version) >= 0,
      "downgrade_rejected",
    );
    // Same version with different bytes is an unpublished/corrupt replacement,
    // never an implicit overwrite of a released version.
    requireState(
      version !== old.version || digest === old.digest,
      "version_collision",
    );
  }
  const entry = {
    ...(current ?? {
      name: NAME,
      policy: { installation: "AVAILABLE", authentication: "ON_USE" },
      category: "Productivity",
    }),
    source: {
      ...(object(current?.source) ? current.source : {}),
      source: "local",
      path,
    },
    flockbot: { ...(current?.flockbot ?? {}), owner: OWNER, schema: 1 },
  };
  const changed = JSON.stringify(entry) !== JSON.stringify(current);
  const receipt = {
    owner: OWNER,
    schema: 1,
    version,
    digest,
    connectionSchema: "browser-v1",
    brokerProtocol: 1,
    runtimeFamily: "node22",
  };
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const stages = join(root, ".stages");
  directPath(stages);
  mkdirSync(stages, { recursive: true, mode: 0o700 });
  syncDirectory(root);
  recoverStages(stages, beforeCommit);
  if (info(target)) {
    const installed = sourceReceipt(target);
    requireState(
      installed.digest === digest && installed.version === version,
      "ownership_conflict",
    );
  } else {
    const name = randomUUID();
    const stage = join(stages, name);
    stageIntent(stages, name);
    beforeCommit("stage_intent");
    mkdirSync(stage, { mode: 0o700 });
    beforeCommit("stage_created");
    writeFileSync(join(stage, ".stage-owner"), OWNER, {
      mode: 0o600,
      flag: "wx",
    });
    const payload = join(stage, "plugin");
    cpSync(plugin, payload, { recursive: true });
    requireState(sourceDigest(payload) === digest, "source_changed");
    writeFileSync(join(payload, RECEIPT), `${JSON.stringify(receipt)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    beforeCommit("source_staged");
    requireState(!info(target), "concurrent_edit");
    renameSync(payload, target);
    cleanStage(stages, name, beforeCommit);
  }
  state.source = changed ? "prepared" : "reused";
  // Publishing the payload first makes every interruption safe: the catalog
  // points either to a prior retained source or to this complete new source.
  beforeCommit("catalog_commit");
  requireState(same(snapshot, read(file)), "concurrent_edit");
  if (current) sourceReceipt(resolve(home, sourcePath(current)));
  sourceReceipt(target);
  requireState(sourceDigest(plugin) === digest, "source_changed");
  if (changed) {
    catalog.plugins = current
      ? catalog.plugins.map((item) => (item === current ? entry : item))
      : [...catalog.plugins, entry];
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const temporary = join(dirname(file), `.flockbot-catalog-${randomUUID()}`);
    const fd = openSync(temporary, "wx", snapshot?.mode ?? 0o600);
    try {
      writeFileSync(fd, `${JSON.stringify(catalog, null, 2)}\n`);
      fsyncSync(fd);
      chmodSync(temporary, snapshot?.mode ?? 0o600);
      requireState(same(snapshot, read(file)), "concurrent_edit");
      renameSync(temporary, file);
    } finally {
      closeSync(fd);
      if (existsSync(temporary)) rmSync(temporary);
    }
  }
  return {
    schema: 1,
    ok: true,
    version,
    requestedVersion: version,
    installedVersion: version,
    sourceIdentity: digest,
    marketplace: catalog.name,
    plugin: NAME,
    source: changed ? "prepared" : "reused",
    runtime,
    connection,
    authentication: "not_checked",
    host: "not_installed",
    remaining: [
      ...(runtime === "prepared" ? [] : ["runtime_prepare"]),
      "host_install",
      "host_reload",
      "check_saved_status",
    ],
  };
}

function codex(args, cwd) {
  const stdio = ["ignore", "pipe", "pipe"];
  if (process.env.FLOCKBOT_INSTALL_LOCK_FD === "9") {
    while (stdio.length < 9) stdio.push("ignore");
    stdio.push(9);
  }
  const result = spawnSync("codex", args, {
    cwd,
    encoding: "utf8",
    timeout: 60000,
    killSignal: "SIGKILL",
    maxBuffer: 256 * 1024,
    stdio,
  });
  if (result.error?.code === "ENOENT") throw new InstallError("codex_missing");
  if (result.error || result.status !== 0)
    throw new InstallError("codex_failed");
  return result.stdout;
}
export function installInCodex(
  result,
  home,
  run = (args) => codex(args, home),
  codexHome = join(home, ".codex"),
) {
  try {
    requireState(
      /^codex(?:-cli)? \d+\.\d+\.\d+/m.test(run(["--version"])),
      "codex_unsupported",
    );
    for (const args of [
      ["plugin", "add", "--help"],
      ["plugin", "marketplace", "add", "--help"],
    ]) {
      let help;
      try {
        help = run(args);
      } catch (error) {
        if (error instanceof InstallError && error.code === "codex_missing")
          throw error;
        throw new InstallError("codex_unsupported");
      }
      requireState(/--json/.test(help), "codex_unsupported");
    }
    const markets = json(run(["plugin", "marketplace", "list", "--json"]));
    requireState(Array.isArray(markets.marketplaces), "codex_unsupported");
    const named = markets.marketplaces.filter(
      (market) => market.name === result.marketplace,
    );
    requireState(
      named.length <= 1 &&
        named.every((market) => market.root === home) &&
        markets.marketplaces.every(
          (market) =>
            market.root !== home || market.name === result.marketplace,
        ),
      "host_source_conflict",
    );
    const plugins = json(run(["plugin", "list", "--json"]));
    requireState(Array.isArray(plugins.installed), "codex_unsupported");
    requireState(
      !plugins.installed.some(
        (entry) =>
          entry.name === NAME && entry.marketplaceName !== result.marketplace,
      ),
      "host_source_conflict",
    );
    const hostKey = createHash("sha256")
      .update(resolve(codexHome))
      .digest("hex");
    const receiptFile = join(home, ".flockbot", "hosts", `${hostKey}.json`);
    const previous = read(receiptFile, 4096);
    const receipt = previous ? json(previous.bytes) : null;
    requireState(
      !receipt || (receipt.owner === OWNER && receipt.schema === 1),
      "ownership_conflict",
    );
    const installed = plugins.installed.filter(
      (entry) =>
        entry.name === NAME && entry.marketplaceName === result.marketplace,
    );
    requireState(installed.length <= 1, "host_source_conflict");
    // A successful owned install receipt plus host-reported presence avoids
    // rewriting host configuration on repeat/cross-route setup. Reload remains
    // required; this receipt is not authentication or loaded-cache evidence.
    const reuse =
      named.length === 1 &&
      installed.length === 1 &&
      receipt?.sourceIdentity === result.sourceIdentity &&
      receipt?.marketplace === result.marketplace;
    if (!named.length) {
      const added = json(run(["plugin", "marketplace", "add", home, "--json"]));
      requireState(
        added.marketplaceName === result.marketplace &&
          added.installedRoot === home,
        "host_source_conflict",
      );
    }
    if (!reuse) {
      const added = json(
        run(["plugin", "add", `${NAME}@${result.marketplace}`, "--json"]),
      );
      requireState(
        added.name === NAME && added.marketplaceName === result.marketplace,
        "codex_unsupported",
      );
      directPath(receiptFile);
      mkdirSync(dirname(receiptFile), { recursive: true, mode: 0o700 });
      const temporary = `${receiptFile}.${randomUUID()}`;
      try {
        writeFileSync(
          temporary,
          `${JSON.stringify({ ...(receipt ?? {}), owner: OWNER, schema: 1, sourceIdentity: result.sourceIdentity, marketplace: result.marketplace, version: result.version })}\n`,
          { flag: "wx", mode: 0o600 },
        );
        requireState(same(previous, read(receiptFile)), "concurrent_edit");
        renameSync(temporary, receiptFile);
      } finally {
        if (existsSync(temporary)) rmSync(temporary);
      }
    }
    return {
      ...result,
      host: "reload_required",
      remaining: [
        ...(result.runtime === "prepared" ? [] : ["runtime_prepare"]),
        "host_reload",
        "check_saved_status",
        ...(["sign_in_required", "sign_in_pending"].includes(result.connection)
          ? ["sign_in"]
          : []),
      ],
    };
  } catch (error) {
    return failureResult(
      error,
      { ...result, host: "installation_required" },
      "codex_failed",
    );
  }
}

// Desktop callers prepare the exact same owned source and runtime. The host's
// supported plugin UI owns installation; no CLI discovery or host receipt write.
export function desktopHandoff(result, home) {
  const path = encodeURIComponent(
    join(home, ".agents/plugins/marketplace.json"),
  ).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return {
    ...result,
    host: "manual_install_required",
    pluginPageUrl: `codex://plugins/${NAME}?marketplacePath=${path}`,
    remaining: [
      ...(result.runtime === "prepared" ? [] : ["runtime_prepare"]),
      "host_install",
      "host_reload",
      "check_saved_status",
      ...(["sign_in_required", "sign_in_pending"].includes(result.connection)
        ? ["sign_in"]
        : []),
    ],
  };
}

const self = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === self) {
  let result;
  const state = {};
  try {
    const { values } = parseArgs({
      options: {
        plugin: { type: "string" },
        route: { type: "string", default: "tui" },
        locked: { type: "boolean" },
      },
    });
    requireState(
      ["tui", "desktop"].includes(values.route) &&
        values.plugin &&
        process.env.HOME,
      "invalid_arguments",
    );
    if (!values.locked) {
      const child = spawnSync(
        "/bin/bash",
        [
          join(dirname(self), "install-lock.sh"),
          process.execPath,
          "--disable-warning=ExperimentalWarning",
          self,
          ...process.argv.slice(2),
          "--locked",
        ],
        { stdio: "inherit" },
      );
      process.exit(child.status ?? 1);
    }
    const lock = fstatSync(9),
      expected = lstatSync(join(process.env.HOME, ".flockbot-install.lock"));
    requireState(
      process.env.FLOCKBOT_INSTALL_LOCK_FD === "9" &&
        lock.ino === expected.ino &&
        lock.dev === expected.dev,
      "coordination_failed",
    );
    result = installLocalPlugin({
      state,
      home: process.env.HOME,
      plugin: values.plugin,
      installRoot:
        process.env.FLOCKBOT_INSTALL_ROOT ??
        join(process.env.HOME, "Library/Application Support/Flockbot MCP"),
    });
    result =
      values.route === "desktop"
        ? desktopHandoff(result, process.env.HOME)
        : installInCodex(
            result,
            process.env.HOME,
            undefined,
            process.env.CODEX_HOME ?? join(process.env.HOME, ".codex"),
          );
  } catch (error) {
    result = failureResult(error, state);
  }
  console.log(JSON.stringify(result));
  process.exitCode = result.ok ? 0 : 1;
}
