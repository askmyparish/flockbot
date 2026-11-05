import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const number = "(?:0|[1-9]\\d*)";
const identifier = "(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)";
const versionPattern = new RegExp(
  `^${number}\\.${number}\\.${number}(?:-${identifier}(?:\\.${identifier})*)?$`,
);
export const PLUGINS = ["flockbot-macos", "flockbot-windows"];

/** The MCP package owns the release version; generated consumers must agree. */
export async function releaseVersion(root = process.cwd()) {
  const { version } = JSON.parse(
    await readFile(join(root, "adapters/mcp/package.json"), "utf8"),
  );
  assert.equal(typeof version, "string", "Missing MCP release version.");
  assert.match(version, versionPattern, "Invalid MCP release version.");
  return version;
}

export async function syncVersions(root = process.cwd(), check = false) {
  const version = await releaseVersion(root);
  const files = new Map([
    [
      "adapters/mcp/src/version.ts",
      `// Generated from adapters/mcp/package.json by npm run release:sync.\nexport const MCP_VERSION = "${version}";\n`,
    ],
  ]);
  for (const name of PLUGINS) {
    const path = `plugins/${name}/.codex-plugin/plugin.json`;
    const manifest = JSON.parse(await readFile(join(root, path), "utf8"));
    manifest.version = version;
    files.set(path, `${JSON.stringify(manifest, null, 2)}\n`);
    files.set(`plugins/${name}/runtime.version`, `${version}\n`);
  }
  for (const [path, expected] of files) {
    if (check)
      assert.equal(
        await readFile(join(root, path), "utf8"),
        expected,
        `${path} is stale. Run npm run release:sync.`,
      );
    else await writeFile(join(root, path), expected);
  }
  return version;
}

/** Select the reviewed changelog section, never generate notes during publication. */
export function releaseNotes(changelog, version) {
  assert.match(version, versionPattern, "Invalid MCP release version.");
  const sections = changelog.split(/^## /m).slice(1);
  const section = sections.find(
    (part) => part.split("\n", 1)[0].trim() === version,
  );
  assert.ok(section, `No changelog entry for ${version}.`);
  const body = section.slice(section.indexOf("\n") + 1).trim();
  assert.ok(body, `Empty changelog entry for ${version}.`);
  return `${body}\n`;
}
