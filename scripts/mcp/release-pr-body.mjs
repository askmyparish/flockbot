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
  "This PR prepares the version and reviewed changelog for the Mac and Windows apps. " +
    "Merging it publishes nothing. After merging, run `adapters/macos/release.sh` and `adapters/windows/release.sh` from the merged commit; " +
    "each publishes this changelog section as its release notes. Packages are not published to npm.\n\n" +
    body.slice(section + 1),
);
