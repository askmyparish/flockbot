import { homedir } from "node:os";
import { join } from "node:path";

function userDirectory(
  name: string,
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
  home: string,
): string {
  if (platform === "darwin") {
    return join(home, "Library", "Application Support", name);
  }
  if (platform === "win32") {
    return join(
      environment.LOCALAPPDATA ?? join(home, "AppData", "Local"),
      name,
    );
  }
  return join(home, ".local", "state", name);
}

/** One stable location per OS user, outside plugin caches and runtime installs. */
export function connectionProfileDirectory(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  return userDirectory("Flockbot MCP", platform, environment, home);
}
