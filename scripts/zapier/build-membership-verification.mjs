import { constants } from "node:fs";
import { open, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// Separate artifact only: the normal build entry and its write gate stay intact.
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--private-plan-file" || !args[1]) {
  console.error(
    "Use --private-plan-file <private-file>. No live calls are made.",
  );
  process.exitCode = 2;
} else {
  let handle;
  let directory;
  try {
    handle = await open(args[1], constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.size > 8192 ||
      (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new Error();
    const input = JSON.parse(await handle.readFile("utf8"));
    await handle.close();
    handle = undefined;
    const createdAt = Date.now();
    const plan = {
      subdomain: input.subdomain,
      networkId: input.networkId,
      groupId: input.groupId,
      emailDigest:
        typeof input.testEmail === "string"
          ? createHash("sha256").update(input.testEmail.trim()).digest("hex")
          : "",
      createdAt,
      expiresAt: createdAt + 30 * 60_000,
    };
    if (
      input.consent !== "authorize-restricted-membership-build" ||
      input.testOnlyLoginConfirmed !== true ||
      input.fictionalRecordConfirmed !== true ||
      typeof plan.subdomain !== "string" ||
      !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(plan.subdomain) ||
      typeof plan.networkId !== "string" ||
      !/^[1-9][0-9]*$/.test(plan.networkId) ||
      typeof plan.groupId !== "string" ||
      !/^[1-9][0-9]*$/.test(plan.groupId) ||
      typeof input.testEmail !== "string" ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.testEmail.trim())
    )
      throw new Error();
    directory = await mkdtemp(join(tmpdir(), "flockbot-membership-test-"));
    await mkdir(join(directory, "dist"));
    const entry = fileURLToPath(
      new URL(
        "../../adapters/zapier/src/membership-verification.ts",
        import.meta.url,
      ),
    );
    await build({
      stdin: {
        contents: `import { createMembershipVerificationApp } from ${JSON.stringify(entry)}; export default createMembershipVerificationApp(${JSON.stringify(plan)});`,
        resolveDir: fileURLToPath(new URL("../..", import.meta.url)),
        sourcefile: "membership-verification-entry.ts",
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
    // The hosted CommonJS wrapper loads index.js directly, regardless of main.
    await writeFile(
      join(directory, "index.js"),
      'module.exports = require("./dist/index.cjs");\n',
    );
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({
        name: "@askmyparish/flockbot-membership-verification",
        version: "2.0.1",
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
    console.log(
      JSON.stringify({
        directory,
        version: "2.0.1",
        expiresAt: plan.expiresAt,
      }),
    );
  } catch {
    if (directory) await rm(directory, { recursive: true, force: true });
    console.error(
      "Membership verification build refused; private values were not printed.",
    );
    process.exitCode = 1;
  } finally {
    await handle?.close();
  }
}
