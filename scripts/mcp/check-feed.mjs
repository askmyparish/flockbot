import { readFile } from "node:fs/promises";
import {
  compareReleases,
  newestInFeed,
} from "../../adapters/mcp/src/updates.ts";

// Fails when the published feed already offers a newer release than the
// version being released, such as when an earlier release is finished after a
// later one, so installs and the download link never go back to an older
// version. The replacement feed is this release's own, which in an appcast
// also keeps earlier entries, so the check uses its entry for `version`.
// Orders releases the way the apps' updaters do. Run with Bun, which loads the
// connector's TypeScript:
//
//   bun scripts/mcp/check-feed.mjs <appcast|velopack> <published> <replacement> <version>
const [format, publishedPath, replacementPath, version] = process.argv.slice(2);
if (
  (format !== "appcast" && format !== "velopack") ||
  !publishedPath ||
  !replacementPath ||
  !version
) {
  process.stderr.write(
    "Usage: bun scripts/mcp/check-feed.mjs <appcast|velopack> <published> <replacement> <version>\n",
  );
  process.exit(2);
}
const read = (path) => readFile(path, "utf8");
const published = newestInFeed(await read(publishedPath), format);
const release = newestInFeed(await read(replacementPath), format, version);
if (!release) {
  process.stderr.write(`${replacementPath} doesn't list ${version}.\n`);
  process.exit(1);
}
if (published && (compareReleases(published, release, format) ?? 1) > 0) {
  process.stderr.write(
    `The published feed already offers ${published.version}, newer than ${version}. Release a newer version instead.\n`,
  );
  process.exit(1);
}
