import { cp, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Prepare only disposable host-check state. Copy cached browser binaries into a
// direct directory: setup deliberately rejects redirected installation paths.
export async function prepareCodexBrowserHome(cache, temporary = tmpdir()) {
  const scratch = await mkdtemp(
    join(await realpath(temporary), "flockbot-codex-browser-"),
  );
  const home = join(scratch, "home");
  const codexHome = join(home, ".codex");
  const installRoot = join(home, "Library/Application Support/Flockbot MCP");
  try {
    await mkdir(codexHome, { recursive: true });
    await mkdir(installRoot, { recursive: true });
    await cp(cache, join(installRoot, "browser-engines"), {
      recursive: true,
      dereference: true,
    });
    return { scratch, home, codexHome, installRoot };
  } catch (error) {
    await rm(scratch, { recursive: true, force: true });
    throw error;
  }
}
