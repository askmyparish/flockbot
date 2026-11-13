import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../..", import.meta.url));
const tools = new Set([
  "status",
  "groups",
  "subscriber_count",
  "find_members",
  "member_filters",
  "member",
  "member_groups",
  "member_communication_status",
  "member_latest_email_status",
  "email_analytics",
  "email_recipients",
  "group_members",
  "group_notes",
  "find_notes",
  "note",
  "is_member",
]);
class DevelopmentError extends Error {}

export function parseDevelopmentArgs(args) {
  let values;
  try {
    ({ values } = parseArgs({
      args,
      options: {
        help: { type: "boolean" },
        live: { type: "boolean" },
        parish: { type: "string" },
        tool: { type: "string" },
        input: { type: "string" },
        verbose: { type: "boolean" },
        "restart-owner": { type: "boolean" },
      },
    }));
  } catch {
    throw new DevelopmentError("Invalid runner arguments. Use --help.");
  }
  if (values.help) return { mode: "help" };
  if (!values.live) {
    if (Object.keys(values).length)
      throw new DevelopmentError(
        "Live options require explicit --live consent.",
      );
    return { mode: "offline" };
  }
  if (!tools.has(values.tool))
    throw new DevelopmentError(
      "Select one allowlisted read-only tool with --tool.",
    );
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(values.parish ?? ""))
    throw new DevelopmentError(
      "Provide the expected parish subdomain with --parish.",
    );
  return { ...values, mode: "live" };
}

export function readDevelopmentInput(path) {
  if (!path) return {};
  try {
    const text = readFileSync(path);
    if (text.length > 16 * 1024) throw new Error();
    const input = JSON.parse(text.toString("utf8"));
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new Error();
    if (Object.hasOwn(input, "verboseDiagnostics")) throw new Error();
    return input;
  } catch {
    throw new DevelopmentError(
      "Input must be a JSON object under 16 KiB. Use --verbose, not verboseDiagnostics in the file.",
    );
  }
}

/** One MCP read; the injected runtime is the freshly bundled application code. */
export async function runLiveRead(
  options,
  input,
  runtime,
  connection,
  failureLog,
) {
  // Enforce the live gate even when called outside the command-line entry point.
  if (options.mode !== "live" || !options.live || !tools.has(options.tool))
    throw new DevelopmentError(
      "Explicit live consent and a read-only tool are required.",
    );
  if (Object.hasOwn(input, "verboseDiagnostics"))
    throw new DevelopmentError("Verbose capture requires --verbose.");
  const expected = runtime.diagnosticRuntime;
  if (!expected.fingerprint)
    throw new DevelopmentError("The local build fingerprint is unavailable.");
  let ownsRuntime = false;
  let client;
  let server;
  const inspect = () =>
    runtime.runDiagnostic(
      "status",
      async () => {
        const status = await connection.status();
        const owner = runtime.verboseDiagnostic("success")?.browserRuntime;
        ownsRuntime =
          owner?.fingerprint === expected.fingerprint &&
          owner?.version === expected.version;
        if (status.parish !== options.parish)
          throw new DevelopmentError(
            "Saved parish does not match --parish. No live read was made.",
          );
        if (status.state !== "ready")
          throw new DevelopmentError(
            "Saved connection is not ready. Sign in separately; no reconnect was attempted.",
          );
        return ownsRuntime;
      },
      undefined,
      false,
      true, // Local status only: metadata identity, no response bodies or log write.
    );
  try {
    const matching = await inspect();
    if (options["restart-owner"]) {
      await connection.shutdown();
      ownsRuntime = false;
      if (!(await inspect()))
        throw new DevelopmentError(
          "Browser owner did not start the current build. No live read was made.",
        );
    } else if (!matching) {
      throw new DevelopmentError(
        "Browser owner is running another build. Pause Codex calls and opt in with --restart-owner.",
      );
    }
    server = runtime.createFlocknoteServer(connection, { failureLog });
    client = new Client({ name: "flockbot-development", version: "1" });
    const [serverTransport, clientTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({
      name: options.tool,
      arguments: { ...input, verboseDiagnostics: options.verbose === true },
    });
    if (!result.structuredContent)
      throw new DevelopmentError(
        "The MCP request was rejected. Check the tool's input schema; no retry was attempted.",
      );
    return {
      runtime: expected,
      tool: options.tool,
      result: result.structuredContent,
    };
  } finally {
    try {
      await client?.close();
      await server?.close();
    } finally {
      // Leave installed Codex free to start its own build on the next call.
      // Never stop an unrelated/stale owner without explicit restart consent.
      if (ownsRuntime) await connection.shutdown();
      await connection.close();
    }
  }
}

async function main() {
  const options = parseDevelopmentArgs(process.argv.slice(2));
  if (options.mode === "help") {
    console.log(`Usage: npm run dev:mcp -- [options]
No options: run focused offline read-tool tests; never access the saved profile.
Live: --live --parish <subdomain> --tool <tool> [--input <file.json>]
      [--verbose] [--restart-owner]
Read tools: ${[...tools].join(", ")}
Live mode rebuilds locally, checks saved parish/readiness and runtime identity,
and calls one MCP tool. It never connects, writes parish data, pages or retries.
--verbose saves the existing sanitized diagnostic capture locally.
--restart-owner stops the shared local browser; pause other clients first.
The development owner is stopped afterward; the saved session is retained.
Tool results can contain personal data. Do not put credentials in input files.`);
    return;
  }
  if (options.mode === "offline") {
    const test = spawnSync(
      process.execPath,
      [
        "node_modules/vitest/vitest.mjs",
        "run",
        "test/mcp/develop.test.mjs",
        "test/mcp/member-search.test.ts",
        "test/member-latest-email-status.test.ts",
        "test/email-analytics.test.ts",
        "test/email-recipients.test.ts",
        "test/group-notes.test.ts",
        "test/note-search.test.ts",
        "test/note.test.ts",
      ],
      { cwd: root, stdio: "inherit" },
    );
    process.exitCode = test.status ?? 1;
    return;
  }
  const input = readDevelopmentInput(options.input);
  const entry = resolve(root, "adapters/mcp/dist/development/index.mjs");
  await build({
    absWorkingDir: root,
    entryPoints: ["scripts/mcp/development-runtime.ts"],
    outfile: entry,
    bundle: true,
    external: ["playwright"],
    platform: "node",
    target: "node22",
    format: "esm",
    logLevel: "silent",
    banner: {
      js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
    },
  });
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve(
    root,
    "adapters/mcp/.cache/browsers",
  );
  const runtime = await import(pathToFileURL(entry).href);
  const result = await runLiveRead(
    options,
    input,
    runtime,
    new runtime.BrowserService({ entry }),
    new runtime.FailureLog(),
  );
  console.log(JSON.stringify(result, null, 2));
  if (result.result.ok === false) process.exitCode = 1;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(
      error instanceof DevelopmentError
        ? error.message
        : "Development read failed; no retry was attempted. Check local diagnostics.",
    );
    process.exitCode = 1;
  });
}
