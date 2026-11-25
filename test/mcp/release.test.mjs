import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  releaseNotes,
  releaseVersion,
  syncVersions,
} from "../../scripts/mcp/release-version.mjs";

const roots = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture(version = "0.3.0-beta.0") {
  const root = await mkdtemp(join(tmpdir(), "flockbot-release-test-"));
  roots.push(root);
  await mkdir(join(root, "adapters/mcp/src"), { recursive: true });
  await writeFile(
    join(root, "adapters/mcp/package.json"),
    JSON.stringify({ version }),
  );
  return root;
}

it.each(["0.2.1", "0.3.0-beta.0", "1.0.0-rc.12"])(
  "synchronizes the generated version module (%s)",
  async (version) => {
    const root = await fixture(version);
    expect(await syncVersions(root)).toBe(version);
    await expect(syncVersions(root, true)).resolves.toBe(version);
    expect(
      await readFile(join(root, "adapters/mcp/src/version.ts"), "utf8"),
    ).toContain(`MCP_VERSION = "${version}"`);
  },
);

it("fails closed for version drift without repairing files during a check", async () => {
  const root = await fixture();
  await syncVersions(root);
  const path = join(root, "adapters/mcp/src/version.ts");
  await writeFile(path, 'export const MCP_VERSION = "0.1.0";\n');
  await expect(syncVersions(root, true)).rejects.toThrow("version.ts is stale");
  expect(await readFile(path, "utf8")).toBe(
    'export const MCP_VERSION = "0.1.0";\n',
  );
});

it.each([
  "../outside",
  "0.2.0\nmalicious",
  "01.2.0",
  "0.2.0-beta.01",
  "0.2.0+build",
  null,
])("rejects an unsafe or unsupported release version (%s)", async (version) => {
  await expect(releaseVersion(await fixture(version))).rejects.toThrow();
});

it("uses exactly the reviewed changelog section including nested headings", () => {
  const changelog =
    "# MCP\n\n## 0.3.0-beta.0\n\n### Minor Changes\n\n- New feature.\n\n## 0.2.0\n\n- Old feature.\n";
  expect(releaseNotes(changelog, "0.3.0-beta.0")).toBe(
    "### Minor Changes\n\n- New feature.\n",
  );
  expect(() => releaseNotes(changelog, "0.3.0")).toThrow("No changelog entry");
  expect(() => releaseNotes("## 0.3.0\n\n", "0.3.0")).toThrow(
    "Empty changelog entry",
  );
});
