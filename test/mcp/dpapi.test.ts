import { describe, expect, it, vi } from "vitest";
import {
  DpapiProtector,
  type CommandRunner,
} from "../../adapters/mcp/src/dpapi.js";

describe("current-user DPAPI boundary", () => {
  it("keeps plaintext off argv and round-trips it through private stdin/stdout", async () => {
    const secret = "fictional-ipc-key";
    const run = vi
      .fn<CommandRunner>()
      .mockResolvedValueOnce({ status: 0, stdout: "fictional-ciphertext" })
      .mockResolvedValueOnce({
        status: 0,
        stdout: Buffer.from(secret).toString("base64"),
      });
    const protector = new DpapiProtector("C:\\Windows", run);
    expect(await protector.protect(secret)).toBe("fictional-ciphertext");
    expect(await protector.unprotect("fictional-ciphertext")).toBe(secret);
    expect(run.mock.calls[0]?.[2]).toBe(Buffer.from(secret).toString("base64"));
    for (const [command, args] of run.mock.calls) {
      expect(command).toBe(
        "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      );
      expect(args.join(" ")).toContain("DataProtectionScope]::CurrentUser");
      expect(args.join(" ")).not.toContain(secret);
      expect(args).toContain("-NonInteractive");
    }
  });

  it.each([
    [3, "denied"],
    [4, "policy_blocked"],
    [1, "unavailable"],
  ])("sanitizes a failed helper (%s)", async (status, code) => {
    const protector = new DpapiProtector("C:\\Windows", async () => ({
      status: Number(status),
      stdout: "fictional-private-error",
    }));
    const failure = protector.unprotect("fictional-ciphertext");
    await expect(failure).rejects.toMatchObject({ code });
    await failure.catch((error: unknown) =>
      expect(String(error)).not.toContain("fictional-private-error"),
    );
  });
});
