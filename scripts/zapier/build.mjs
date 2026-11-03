import { build } from "esbuild";

await build({
  entryPoints: ["adapters/zapier/src/index.ts"],
  outfile: "adapters/zapier/dist/index.cjs",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  external: ["zapier-platform-core"],
  footer: { js: "module.exports = module.exports.default;" },
});
