import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { unzipSync } from "fflate";
import { bundleBrowser, CODEX_VERSION } from "./browser-build.mjs";
import { zipDirectory } from "./archive.mjs";
import { syncVersions } from "./release-version.mjs";

const NODE_VERSION = (
  await readFile(new URL("../../.node-version", import.meta.url), "utf8")
).trim();
assert.match(
  NODE_VERSION,
  /^22\.\d+\.\d+$/,
  "Invalid pinned Node runtime version.",
);
const targets = {
  "darwin-arm64": {
    plugin: "flockbot-macos",
    archive: `node-v${NODE_VERSION}-darwin-arm64.tar.xz`,
    sha256: "037650d0839f457747396f052073fb48333d31bf5abd3c98b74da20d89ebb1ad",
    node: "node",
  },
  "win32-x64": {
    plugin: "flockbot-windows",
    archive: `node-v${NODE_VERSION}-win-x64.zip`,
    sha256: "cbc74b5e0982c9dbb41525fd8fb5dcd32fbee237863f7829072f4639a1ce5f20",
    node: "node.exe",
  },
};
const { values } = parseArgs({
  options: {
    out: { type: "string", default: "adapters/mcp/artifacts/codex" },
    cache: { type: "string", default: "adapters/mcp/.cache/runtime" },
    target: { type: "string", multiple: true },
    "verify-pins": { type: "boolean", default: false },
  },
});
await syncVersions(process.cwd(), true);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const scratch = await mkdtemp(join(tmpdir(), "flockbot-codex-package-"));
try {
  const out = resolve(values.out);
  await mkdir(out, { recursive: true });
  const bundle = join(scratch, "browser");
  await bundleBrowser(bundle);
  const artifacts = [];
  for (const name of values.target ?? Object.keys(targets)) {
    const target = targets[name];
    if (!target) throw new Error("Unsupported Codex package target.");
    const cache = resolve(values.cache, target.archive);
    await mkdir(resolve(values.cache), { recursive: true });
    let bytes;
    try {
      bytes = await readFile(cache);
    } catch {
      const response = await fetch(
        `https://nodejs.org/dist/v${NODE_VERSION}/${target.archive}`,
      );
      if (!response.ok) throw new Error("Node runtime download failed.");
      bytes = Buffer.from(await response.arrayBuffer());
    }
    if (digest(bytes) !== target.sha256)
      throw new Error("Node runtime integrity check failed.");
    await writeFile(cache, bytes);
    const stage = join(scratch, name);
    await cp(bundle, stage, { recursive: true });
    const stem = target.archive.replace(/\.(tar\.xz|zip)$/, "");
    if (name === "win32-x64") {
      const entries = unzipSync(bytes, {
        filter: ({ name }) =>
          [`${stem}/node.exe`, `${stem}/LICENSE`].includes(name),
      });
      await writeFile(join(stage, "node.exe"), entries[`${stem}/node.exe`]);
      await writeFile(join(stage, "NODE-LICENSE"), entries[`${stem}/LICENSE`]);
    } else {
      const unpacked = join(scratch, "node");
      await mkdir(unpacked);
      execFileSync("tar", [
        "-xJf",
        cache,
        "-C",
        unpacked,
        "--strip-components",
        "1",
        `${stem}/bin/node`,
        `${stem}/LICENSE`,
      ]);
      await copyFile(join(unpacked, "bin/node"), join(stage, "node"));
      await copyFile(join(unpacked, "LICENSE"), join(stage, "NODE-LICENSE"));
    }
    await chmod(join(stage, target.node), 0o755);
    const filename = `flockbot-codex-${CODEX_VERSION}-${name}.zip`;
    await zipDirectory(stage, join(out, filename));
    const sha256 = digest(await readFile(join(out, filename)));
    // The repository's source plugin pins the exact prepared release bytes.
    const pin = resolve("plugins", target.plugin, "runtime.sha256");
    if (values["verify-pins"])
      assert.equal(
        (await readFile(pin, "utf8")).trim(),
        sha256,
        `Release checksum mismatch for ${name}; never rewrite pins during publication.`,
      );
    else await writeFile(pin, `${sha256}\n`);
    artifacts.push({ filename, sha256, target: name });
    console.log(`${sha256}  ${filename}`);
  }
  await writeFile(
    join(out, "artifacts.json"),
    `${JSON.stringify({ version: CODEX_VERSION, artifacts }, null, 2)}\n`,
  );
  await writeFile(
    join(out, "SHA256SUMS"),
    artifacts
      .map(({ filename, sha256 }) => `${sha256}  ${filename}\n`)
      .join(""),
  );
} finally {
  await rm(scratch, { recursive: true, force: true });
}
