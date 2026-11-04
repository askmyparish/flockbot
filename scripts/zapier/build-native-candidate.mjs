import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// Local build only. No credentials, CLI upload, or live calls.
let directory;
try {
  if (process.argv.length !== 2) throw new Error("Unexpected build arguments.");
  directory = await mkdtemp(join(tmpdir(), "flockbot-native-candidate-"));
  await mkdir(join(directory, "dist"));
  const entry = fileURLToPath(
    new URL("../../adapters/zapier/src/native-candidate.ts", import.meta.url),
  );
  await build({
    stdin: {
      contents: `import {createNativeCandidate} from ${JSON.stringify(entry)}; export default createNativeCandidate();`,
      resolveDir: fileURLToPath(new URL("../..", import.meta.url)),
      sourcefile: "native-candidate-entry.ts",
      loader: "ts",
    },
    outfile: join(directory, "dist/index.cjs"),
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    external: ["zapier-platform-core"],
    footer: { js: "module.exports = module.exports.default;" },
    logLevel: "silent",
  });
  await writeFile(
    join(directory, "index.js"),
    'module.exports = require("./dist/index.cjs");\n',
  );
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({
      name: "@askmyparish/flockbot-zapier-native-candidate",
      version: "2.1.6",
      private: true,
      main: "index.js",
      exports: "./index.js",
      files: ["index.js", "dist"],
      engines: { node: ">=22.12.0" },
      dependencies: { "zapier-platform-core": "19.3.0" },
    }),
  );
  await writeFile(
    join(directory, ".gitignore"),
    "node_modules\n.env*\n.zapierrc\ncli-auth.json\nbuild\n",
  );
  console.log(JSON.stringify({ directory, version: "2.1.6" }));
} catch {
  if (directory) await rm(directory, { recursive: true, force: true });
  console.error("Native candidate build failed.");
  process.exitCode = 1;
}
