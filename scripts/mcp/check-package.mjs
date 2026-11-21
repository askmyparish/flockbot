import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { releaseVersion } from "./release-version.mjs";

// Starts the built server as an assistant would, with an empty home directory,
// and checks the stdio contract without contacting Flocknote.
const home = await mkdtemp(join(tmpdir(), "flockbot-package-check-"));
const client = new Client({ name: "fictional-assistant", version: "1" });
try {
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [resolve("adapters/mcp/dist/server/index.mjs")],
      env: { HOME: home, PATH: process.env.PATH ?? "" },
      stderr: "inherit",
    }),
  );
  assert.deepEqual(client.getServerVersion(), {
    name: "flockbot",
    version: await releaseVersion(),
  });
  assert.match(client.getInstructions() ?? "", /Flockbot's sign-in/);
  const { tools } = await client.listTools();
  for (const name of ["status", "connect", "groups", "add_member"])
    assert.ok(
      tools.some((tool) => tool.name === name),
      `Missing ${name} tool.`,
    );
  const status = await client.callTool({ name: "status", arguments: {} });
  assert.equal(status.structuredContent?.state, "not_configured");
} finally {
  await client.close();
  await rm(home, { recursive: true, force: true });
}
