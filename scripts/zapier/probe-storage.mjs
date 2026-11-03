import { constants } from "node:fs";
import { open, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const args = process.argv.slice(2);
if (
  args.length !== 4 ||
  ![
    "--authorize-isolated-storage-probe",
    "--authorize-initialized-storage-probe",
    "--authorize-isolated-storage-diagnostic",
    "--authorize-storage-comparison-diagnostic",
    "--authorize-storage-contention-diagnostic",
  ].includes(args[0]) ||
  args[1] !== "--dedicated-store" ||
  args[2] !== "--secret-file" ||
  !args[3]
) {
  console.error(
    "No requests made. Use --authorize-isolated-storage-probe (or separately approved --authorize-initialized-storage-probe / --authorize-isolated-storage-diagnostic / --authorize-storage-comparison-diagnostic / --authorize-storage-contention-diagnostic) --dedicated-store --secret-file <private-file> with a dedicated Storage test account.",
  );
  process.exitCode = 2;
} else {
  let directory;
  let handle;
  try {
    handle = await open(args[3], constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.size > 128 ||
      (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new Error("Invalid secret file.");
    const secret = (await handle.readFile("utf8")).trim();
    await handle.close();
    handle = undefined;
    directory = await mkdtemp(join(tmpdir(), "flockbot-storage-probe-"));
    const output = join(directory, "probe.mjs");
    const comparison = [
      "--authorize-storage-comparison-diagnostic",
      "--authorize-storage-contention-diagnostic",
    ].includes(args[0]);
    const diagnostic = args[0] === "--authorize-isolated-storage-diagnostic";
    await build({
      entryPoints: [
        fileURLToPath(
          new URL(
            comparison
              ? "./storage-comparison.ts"
              : diagnostic
                ? "./storage-diagnostic.ts"
                : "./storage-probe.ts",
            import.meta.url,
          ),
        ),
      ],
      outfile: output,
      bundle: true,
      platform: "node",
      target: "node22",
      format: "esm",
      logLevel: "silent",
    });
    const {
      probeZapierStorage,
      ProbeStorageClient,
      diagnoseZapierStorage,
      compareStorage,
    } = await import(pathToFileURL(output).href);
    const result = comparison
      ? await compareStorage(
          { consent: args[0].slice(2), dedicatedStore: true },
          secret,
        )
      : diagnostic
        ? await diagnoseZapierStorage(
            {
              consent: "authorize-isolated-storage-diagnostic",
              dedicatedStore: true,
            },
            secret,
          )
        : await probeZapierStorage(
            { consent: args[0].slice(2), dedicatedStore: true },
            new ProbeStorageClient(secret),
          );
    console.log(JSON.stringify(result));
    process.exitCode = (
      comparison
        ? !result.failure
        : diagnostic
          ? result.responseReceived && !result.failure
          : result.passed
    )
      ? 0
      : 1;
  } catch {
    console.error("Storage probe failed; no diagnostic secrets were printed.");
    process.exitCode = 1;
  } finally {
    await handle?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}
