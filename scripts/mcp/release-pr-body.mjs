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
  "This PR prepares the MCP version and reviewed changelog. " +
    "Merging it builds the Claude Desktop extension from the merged commit and publishes it as a GitHub release tagged `mcp-v<version>`. " +
    "Beta versions remain prereleases. Packages are not published to npm.\n\n" +
    body.slice(section + 1),
);
