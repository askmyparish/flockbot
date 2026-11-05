import { spawn } from "node:child_process";
import { vi } from "vitest";

const NODE_FLAGS = ["--disable-warning=ExperimentalWarning"];

/** Retry observable state promptly; allow cold child processes time to start under load. */
export function waitFor(
  assertion: () => unknown,
  options?: Exclude<Parameters<typeof vi.waitFor>[1], number>,
) {
  return vi.waitFor(assertion, { interval: 5, timeout: 5000, ...options });
}

export function run(
  entry: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...NODE_FLAGS, entry, ...args], {
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) =>
      resolve({ status: status ?? -1, stdout, stderr }),
    );
  });
}
