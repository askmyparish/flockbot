import { readFile } from "node:fs/promises";
import { releaseNotes, releaseVersion } from "./release-version.mjs";

// Prints the reviewed changelog section for the current version. The Mac and
// Windows release scripts publish it as their release notes.
const version = await releaseVersion();
process.stdout.write(
  releaseNotes(await readFile("adapters/mcp/CHANGELOG.md", "utf8"), version),
);
