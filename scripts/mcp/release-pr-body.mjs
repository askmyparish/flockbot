import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";

const path = process.argv[2];
assert.ok(path, "A release PR body file is required.");
const body = await readFile(path, "utf8");
const section = body.indexOf("\n# Releases\n");
assert.ok(section >= 0, "Changesets release section is missing.");
// The upstream action assumes npm publication. Keep its generated notes while
// describing this repository's GitHub release process.
await writeFile(
  path,
  "This PR prepares the MCP version, reviewed changelog and archive checksum pins. " +
    "Merging this reviewed PR automatically builds, verifies and publishes the GitHub release for the merged commit, including its `mcp-v<version>` tag. " +
    "Beta versions remain prereleases. Packages are not published to npm. " +
    "See [the release runbook](https://github.com/askmyparish/flockbot/blob/main/docs/mcp/releases.md).\n\n" +
    body.slice(section + 1),
);
