import { spawn } from "node:child_process";

export type ProtectedStorageErrorCode =
  | "denied"
  | "unavailable"
  | "policy_blocked";

/** Carries only a fixed code and exit status, never command output. */
export class ProtectedStorageError extends Error {
  readonly code: ProtectedStorageErrorCode;
  readonly exitStatus: number | undefined;
  constructor(code: ProtectedStorageErrorCode, exitStatus?: number) {
    super(`Protected storage failed: ${code}`);
    this.name = "ProtectedStorageError";
    this.code = code;
    this.exitStatus = exitStatus;
  }
}

export interface CommandResult {
  status: number;
  stdout: string;
}
export type CommandRunner = (
  command: string,
  args: readonly string[],
  input?: string,
) => Promise<CommandResult>;

const COMMAND_LIMIT_MS = 10_000;
const MAX_COMMAND_OUTPUT = 16 * 1024;

/** Secrets travel only on private stdio pipes. Child stderr is discarded. */
export const runCommand: CommandRunner = (command, args, input) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "ignore"],
      shell: false,
      windowsHide: true,
      timeout: COMMAND_LIMIT_MS,
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > MAX_COMMAND_OUTPUT) {
        child.kill();
        reject(new ProtectedStorageError("unavailable"));
      }
    });
    child.stdin.on("error", () => undefined);
    child.on("error", () => reject(new ProtectedStorageError("unavailable")));
    child.on("close", (status) => resolve({ status: status ?? -1, stdout }));
    child.stdin.end(input ?? "");
  });

const EXIT_DENIED = 3;
const EXIT_POLICY = 4;

// Double quotes are avoided so Windows argument quoting leaves these unchanged.
function dpapiScript(operation: "Protect" | "Unprotect"): string {
  return [
    "$ErrorActionPreference='Stop'",
    `if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') { exit ${EXIT_POLICY} }`,
    "try {",
    "Add-Type -AssemblyName System.Security",
    "$in=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())",
    `$out=[Security.Cryptography.ProtectedData]::${operation}($in,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)`,
    "[Console]::Out.Write([Convert]::ToBase64String($out))",
    `} catch [Security.Cryptography.CryptographicException] { exit ${EXIT_DENIED} }`,
  ].join("; ");
}

/**
 * Protects local IPC descriptor data with current-user DPAPI via PowerShell 5.1.
 * The caller stores ciphertext in the profile; this class handles only the
 * transformation through bounded private stdio pipes. Access follows the Windows
 * user across connector updates, and other processes of that user can decrypt.
 */
export class DpapiProtector {
  readonly mechanism = "windows-dpapi-current-user-powershell";
  readonly #powershell: string;
  readonly #run: CommandRunner;

  constructor(
    systemRoot: string = process.env.SystemRoot ?? "C:\\Windows",
    run: CommandRunner = runCommand,
  ) {
    this.#powershell = `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
    this.#run = run;
  }

  async #transform(
    operation: "Protect" | "Unprotect",
    base64: string,
  ): Promise<string> {
    const { status, stdout } = await this.#run(
      this.#powershell,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        dpapiScript(operation),
      ],
      base64,
    );
    if (status === EXIT_DENIED)
      throw new ProtectedStorageError("denied", status);
    if (status === EXIT_POLICY) {
      throw new ProtectedStorageError("policy_blocked", status);
    }
    if (status !== 0) throw new ProtectedStorageError("unavailable", status);
    return stdout.trim();
  }

  async protect(value: string): Promise<string> {
    return this.#transform(
      "Protect",
      Buffer.from(value, "utf8").toString("base64"),
    );
  }

  async unprotect(ciphertext: string): Promise<string> {
    const plain = await this.#transform("Unprotect", ciphertext);
    return Buffer.from(plain, "base64").toString("utf8");
  }
}
