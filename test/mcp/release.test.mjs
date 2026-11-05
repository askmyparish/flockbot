import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
  chmod,
  utimes,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { unzipSync } from "fflate";
import {
  PLUGINS,
  releaseNotes,
  releaseVersion,
  syncVersions,
} from "../../scripts/mcp/release-version.mjs";
import { zipDirectory } from "../../scripts/mcp/archive.mjs";

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
  for (const name of PLUGINS) {
    const folder = join(root, "plugins", name, ".codex-plugin");
    await mkdir(folder, { recursive: true });
    await writeFile(
      join(folder, "plugin.json"),
      JSON.stringify({
        name,
        version: "0.2.0",
        description: "Preserve this field",
      }),
    );
  }
  return root;
}

it.each(["0.2.1", "0.3.0-beta.0", "1.0.0-rc.12"])(
  "synchronizes every version consumer without changing unrelated metadata (%s)",
  async (version) => {
    const root = await fixture(version);
    expect(await syncVersions(root)).toBe(version);
    await expect(syncVersions(root, true)).resolves.toBe(version);
    for (const name of PLUGINS) {
      expect(
        await readFile(join(root, "plugins", name, "runtime.version"), "utf8"),
      ).toBe(`${version}\n`);
      expect(
        JSON.parse(
          await readFile(
            join(root, "plugins", name, ".codex-plugin/plugin.json"),
            "utf8",
          ),
        ),
      ).toMatchObject({ version, description: "Preserve this field" });
    }
    expect(
      await readFile(join(root, "adapters/mcp/src/version.ts"), "utf8"),
    ).toContain(`MCP_VERSION = "${version}"`);
  },
);

it("fails closed for version drift without repairing files during a check", async () => {
  const root = await fixture();
  await syncVersions(root);
  const path = join(root, "plugins/flockbot-macos/runtime.version");
  await writeFile(path, "0.1.0\n");
  await expect(syncVersions(root, true)).rejects.toThrow(
    "runtime.version is stale",
  );
  expect(await readFile(path, "utf8")).toBe("0.1.0\n");
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

it("derives an automatic release tag from the reviewed version and refuses a mismatched override", async () => {
  const root = await fixture();
  await syncVersions(root);
  await writeFile(
    join(root, "adapters/mcp/CHANGELOG.md"),
    "# MCP\n\n## 0.3.0-beta.0\n\n- Reviewed feature.\n",
  );
  const output = join(root, "outputs");
  const script = fileURLToPath(
    new URL("../../scripts/mcp/release-info.mjs", import.meta.url),
  );
  const options = { cwd: root, env: { ...process.env, GITHUB_OUTPUT: output } };
  execFileSync(process.execPath, [script], options);
  expect(await readFile(output, "utf8")).toBe(
    "tag=mcp-v0.3.0-beta.0\nprerelease=true\n",
  );
  const notes = join(root, "adapters/mcp/artifacts/codex/release-notes.md");
  expect(await readFile(notes, "utf8")).toBe("- Reviewed feature.\n");
  expect(
    spawnSync(process.execPath, [script, "--tag", "mcp-v99.0.0"], options)
      .status,
  ).not.toBe(0);
  expect(await readFile(output, "utf8")).toBe(
    "tag=mcp-v0.3.0-beta.0\nprerelease=true\n",
  );
});

it("creates reproducible archives across timestamps and non-executable permission differences", async () => {
  const root = await fixture();
  const payload = join(root, "payload");
  await mkdir(payload);
  const path = join(payload, "fixture.txt");
  await writeFile(path, "fictional fixture");
  await chmod(path, 0o600);
  const first = join(root, "first.zip");
  await zipDirectory(payload, first);
  await chmod(path, 0o664);
  await utimes(path, new Date(), new Date());
  const second = join(root, "second.zip");
  await zipDirectory(payload, second);
  expect(await readFile(first)).toEqual(await readFile(second));
  expect(
    Buffer.from(unzipSync(await readFile(second))["fixture.txt"]).toString(),
  ).toBe("fictional fixture");
});

it("emits identical ZIP bytes in UTC and western/eastern timezones", async () => {
  const root = await fixture();
  const payload = join(root, "payload");
  await mkdir(payload);
  await writeFile(join(payload, "fixture.txt"), "fictional fixture");
  const module = new URL("../../scripts/mcp/archive.mjs", import.meta.url).href;
  const archives = [];
  for (const TZ of ["UTC", "Pacific/Honolulu", "Asia/Tokyo"]) {
    const archive = join(root, `${archives.length}.zip`);
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        "const { zipDirectory } = await import(process.argv[1]); await zipDirectory(process.argv[2], process.argv[3]);",
        module,
        payload,
        archive,
      ],
      { env: { ...process.env, TZ } },
    );
    archives.push(await readFile(archive));
  }
  expect(archives[1]).toEqual(archives[0]);
  expect(archives[2]).toEqual(archives[0]);
});
