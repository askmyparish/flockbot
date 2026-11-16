import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { build } from "esbuild";
import { zipDirectory } from "./archive.mjs";
import { releaseVersion } from "./release-version.mjs";

// Claude Desktop replaces this placeholder with the installed extension's path.
const EXTENSION_DIRECTORY = ["$", "{__dirname}"].join("");

const version = await releaseVersion();
const staging = "adapters/mcp/dist/claude-local";
const artifact = `adapters/mcp/artifacts/claude-local/flockbot-local-${version}.mcpb`;

await rm(staging, { recursive: true, force: true });
await mkdir(join(staging, "server"), { recursive: true });
await build({
  entryPoints: ["adapters/mcp/src/local-main.ts"],
  outfile: join(staging, "server", "index.mjs"),
  bundle: true,
  // Reachable only through the browser-backed factory, which this entry replaces.
  external: ["playwright"],
  platform: "node",
  target: "node22",
  format: "esm",
  logLevel: "warning",
  legalComments: "eof",
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
  },
});
await cp("assets/flockbot.png", join(staging, "flockbot.png"));
await writeFile(
  join(staging, "manifest.json"),
  `${JSON.stringify(
    {
      manifest_version: "0.3",
      name: "flockbot-local",
      display_name: "Flockbot (local sign-in preview)",
      version,
      description:
        "Independent Flocknote connector by AskMyParish. Preview for macOS.",
      long_description:
        "Unofficial and independent. Not affiliated with, endorsed by or supported by Flocknote. Sign-in happens on a page served from this computer: the password is sent only to Flocknote and is not saved. The resulting session is kept in a file only this macOS user can read. This preview supports password sign-in only and runs on Claude Desktop's built-in Node.js.",
      author: { name: "AskMyParish", url: "https://askmyparish.com" },
      homepage: "https://askmyparish.com",
      support: "https://github.com/askmyparish/flockbot/issues",
      icon: "flockbot.png",
      license: "MIT",
      server: {
        type: "node",
        entry_point: "server/index.mjs",
        mcp_config: {
          command: "node",
          args: [`${EXTENSION_DIRECTORY}/server/index.mjs`],
        },
      },
      tools_generated: true,
      compatibility: {
        platforms: ["darwin"],
        runtimes: { node: ">=22.13.0" },
      },
    },
    null,
    2,
  )}\n`,
);
await zipDirectory(staging, artifact);
process.stdout.write(`${artifact}\n`);
