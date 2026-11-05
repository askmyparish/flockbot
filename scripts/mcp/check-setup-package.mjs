import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { unzipSync } from "fflate";

const out = resolve(process.argv[2] ?? "adapters/mcp/artifacts/codex");
for (const name of await readdir(out))
  assert.ok(
    !/^flockbot-installer-/.test(name) &&
      !/^flockbot-setup-.*\.html$/.test(name) &&
      name !== "Flockbot Setup.app",
    "Graphical setup output remains in the artifact directory.",
  );
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const metadata = JSON.parse(
  await readFile(join(out, "artifacts.json"), "utf8"),
);
const sums = await readFile(join(out, "SHA256SUMS"), "utf8");
assert.equal(
  sums,
  metadata.artifacts.map((a) => `${a.sha256}  ${a.filename}\n`).join(""),
);
const names = new Set();
let setup;
let upstreamNodePathOccurrences = 0;
const forbidden = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\/Users\/[A-Za-z0-9_.-]+\//,
  /\/(?:private\/)?tmp\/flockbot[^\s/]*\//,
  /[A-Za-z]:\\Users\\[A-Za-z0-9_.-]+\\/,
  /fictional (?:browser session|IPC sentinel|unrelated host configuration)/,
];
function audit(bytes, label, depth = 0) {
  assert.ok(depth < 4, "Unexpected nested archive.");
  let text = Buffer.from(bytes).toString("utf8");
  // The pinned official Node macOS executable embeds its public upstream build
  // root. Permit only that exact prefix, only in Node, never in our resources.
  if (label === "node") {
    upstreamNodePathOccurrences +=
      text.split("/Users/admin/build/ws/").length - 1;
    text = text.replaceAll("/Users/admin/build/ws/", "/upstream-node-build/");
  }
  // Check Linux build paths in our generated resources. Pinned third-party
  // binaries and documentation contain public /home/... examples; the existing
  // guards below still apply to them without treating those examples as leaks.
  if (
    !label.endsWith(".zip") &&
    !label.startsWith("node_modules/") &&
    !["node", "node.exe"].includes(label)
  )
    assert.ok(
      !/\/home\/[A-Za-z0-9_.-]+\//.test(text),
      `Private content in ${label}.`,
    );
  for (const pattern of forbidden)
    assert.ok(!pattern.test(text), `Private content in ${label}.`);
  if (!label.endsWith(".zip")) return;
  const entries = unzipSync(bytes);
  assert.ok(Object.keys(entries).length > 0);
  for (const [name, content] of Object.entries(entries)) {
    assert.ok(
      !name.startsWith("/") &&
        !name.includes("\\") &&
        !name.split("/").some((part) => [".", ".."].includes(part)),
      `Unsafe path in ${label}.`,
    );
    assert.ok(
      !/(^|\/)(?:browser-v1|browser-engines|\.codex|\.agents|\.git|\.DS_Store|\.env|connection\.json|broker\.json|Cookies|Login Data)(\/|$)/i.test(
        name,
      ),
      `Private path in ${label}.`,
    );
    audit(content, name, depth + 1);
  }
  return entries;
}
for (const artifact of metadata.artifacts) {
  assert.match(artifact.filename, /^[a-zA-Z0-9_.-]+$/);
  assert.ok(!names.has(artifact.filename));
  names.add(artifact.filename);
  const bytes = await readFile(join(out, artifact.filename));
  assert.equal(
    digest(bytes),
    artifact.sha256,
    `Final checksum mismatch: ${artifact.filename}`,
  );
  const entries = audit(bytes, artifact.filename);
  if (artifact.kind === "setup") setup = entries;
}
assert.ok(setup, "Audit requires the setup artifact.");
assert.deepEqual(
  Object.keys(setup).sort(),
  [
    "install.sh",
    "runtime.zip",
    "plugin/.codex-plugin/plugin.json",
    "plugin/.mcp.json",
    "plugin/assets/flockbot.svg",
    "plugin/runtime.sha256",
    "plugin/runtime.version",
    "plugin/setup.sh",
    "plugin/skills/setup/SKILL.md",
  ].sort(),
  "Unexpected setup payload files.",
);
const expected = [
  `flockbot-codex-${metadata.version}-darwin-arm64.zip`,
  `flockbot-codex-${metadata.version}-win32-x64.zip`,
  `flockbot-setup-${metadata.version}-darwin-arm64.zip`,
  `flockbot-setup-${metadata.version}-darwin-arm64.md`,
];
assert.deepEqual(
  [...names].sort(),
  expected.sort(),
  "Unexpected release artifacts.",
);
const runtime = metadata.artifacts.find(
  (a) => a.target === "darwin-arm64" && !a.kind,
);
const archive = metadata.artifacts.find((a) => a.kind === "setup");
assert.equal(digest(setup["runtime.zip"]), runtime.sha256);
assert.equal(
  Buffer.from(setup["plugin/runtime.sha256"]).toString().trim(),
  runtime.sha256,
);
assert.equal(
  Buffer.from(setup["plugin/runtime.version"]).toString().trim(),
  metadata.version,
);
const manifest = JSON.parse(
  Buffer.from(setup["plugin/.codex-plugin/plugin.json"]).toString(),
);
assert.equal(manifest.version, metadata.version);
assert.equal(manifest.interface.displayName, "Flockbot");
assert.equal(manifest.author.name, "AskMyParish");
assert.deepEqual(
  setup["plugin/assets/flockbot.svg"],
  new Uint8Array(await readFile("assets/flockbot.svg")),
);
const prompt = await readFile(
  join(out, `flockbot-setup-${metadata.version}-darwin-arm64.md`),
  "utf8",
);
assert.ok(prompt.includes(archive.sha256));
assert.ok(
  prompt.includes(
    `https://github.com/askmyparish/flockbot/releases/download/mcp-v${metadata.version}/${archive.filename}`,
  ),
);
assert.ok(prompt.includes("--route desktop"));
assert.ok(prompt.includes("--route tui"));
console.log(
  `Audited ${metadata.artifacts.length} guide-based artifacts, exact setup payload, nested runtime pin, branding and private-data exclusions. No graphical products. Official Node upstream prefix occurrences: ${upstreamNodePathOccurrences}.`,
);
