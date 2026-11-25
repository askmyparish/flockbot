import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { releaseVersion } from "./release-version.mjs";

// Starts a compiled connector (the one bundled in Flockbot.app, or
// flockbot-mcp.exe) the way an assistant does, with an empty profile, and
// checks the stdio contract without signing in or contacting Flocknote.
//
//   node scripts/mcp/check-connector.mjs <path to flockbot-mcp>
const connector = process.argv[2];
assert.ok(connector, "Name the compiled connector to check.");
const home = await mkdtemp(join(tmpdir(), "flockbot-connector-check-"));
const appData = join(home, "AppData");
await mkdir(join(appData, "Local"), { recursive: true });
await mkdir(join(appData, "Roaming"), { recursive: true });
const client = new Client({ name: "fictional-assistant", version: "1" });
try {
  await client.connect(
    new StdioClientTransport({
      command: resolve(connector),
      env: {
        PATH: process.env.PATH ?? "",
        HOME: home,
        // Windows keeps the profile here; SystemRoot lets Windows programs run.
        USERPROFILE: home,
        LOCALAPPDATA: join(appData, "Local"),
        APPDATA: join(appData, "Roaming"),
        ...(process.env.SystemRoot
          ? { SystemRoot: process.env.SystemRoot }
          : {}),
      },
      stderr: "inherit",
    }),
  );
  assert.deepEqual(client.getServerVersion(), {
    name: "flockbot",
    version: await releaseVersion(),
  });
  const { tools } = await client.listTools();
  for (const name of ["status", "connect", "groups", "add_member"])
    assert.ok(
      tools.some((tool) => tool.name === name),
      `Missing ${name} tool.`,
    );
  const status = await client.callTool({ name: "status", arguments: {} });
  assert.equal(status.structuredContent?.state, "not_configured");
  console.log(`${connector} answered over stdio with ${tools.length} tools.`);
} finally {
  await client.close();
  await rm(home, { recursive: true, force: true });
}
