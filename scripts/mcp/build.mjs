import { rm } from "node:fs/promises";
import { build } from "esbuild";

const out = "adapters/mcp/dist";

await rm(out, { recursive: true, force: true });
await build({
  entryPoints: ["adapters/mcp/src/local-main.ts"],
  outfile: `${out}/server/index.mjs`,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  logLevel: "warning",
  legalComments: "eof",
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
  },
});
