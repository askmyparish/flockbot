import assert from "node:assert/strict";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { releaseNotes, syncVersions } from "./release-version.mjs";

const { values } = parseArgs({
  options: {
    tag: { type: "string" },
    out: { type: "string", default: "adapters/mcp/artifacts/codex" },
  },
});
const version = await syncVersions(process.cwd(), true);
const tag = `mcp-v${version}`;
if (values.tag !== undefined)
  assert.equal(values.tag, tag, "Tag does not match the reviewed version.");
const notes = releaseNotes(
  await readFile("adapters/mcp/CHANGELOG.md", "utf8"),
  version,
);
await mkdir(values.out, { recursive: true });
await writeFile(join(values.out, "release-notes.md"), notes);
if (process.env.GITHUB_OUTPUT)
  await appendFile(
    process.env.GITHUB_OUTPUT,
    `tag=${tag}\nprerelease=${version.includes("-")}\n`,
  );
