import { cp, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { releaseVersion } from "./release-version.mjs";

export const CODEX_VERSION = await releaseVersion();

export async function bundleBrowser(out = "adapters/mcp/dist/browser") {
  await mkdir(out, { recursive: true });
  await build({
    entryPoints: ["adapters/mcp/src/flocknote-main.ts"],
    outfile: join(out, "server", "index.mjs"),
    bundle: true,
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
  for (const name of ["playwright", "playwright-core"]) {
    await cp(resolve("node_modules", name), join(out, "node_modules", name), {
      recursive: true,
    });
  }
  await cp("scripts/mcp/setup-browser.mjs", join(out, "setup-browser.mjs"));
  for (const name of ["install-core.mjs", "install-lock.sh"]) {
    await cp(join("scripts/mcp/installer", name), join(out, name));
  }
  await writeFile(
    join(out, "package.json"),
    `${JSON.stringify({ name: "flockbot-local-runtime", version: CODEX_VERSION, private: true, type: "module" })}\n`,
  );
}
