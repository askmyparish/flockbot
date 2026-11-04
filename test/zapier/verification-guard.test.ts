import { inspect } from "node:util";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  LIVE_VERIFICATION_CONSENT,
  runIsolatedVerification,
  type TargetEvidence,
  type VerificationExecution,
} from "../../scripts/zapier/verification-guard.js";
import { FlockbotError } from "../../src/index.js";

const target = {
  origin: "https://example-parish.flocknote.com",
  networkId: "501",
};
function request() {
  return {
    consent: LIVE_VERIFICATION_CONSENT,
    subdomain: "example-parish",
    expectedNetworkId: "501",
    testOnlyLoginConfirmed: true,
    allowedGroupIds: ["102"],
    groupId: "102",
    operation: "add-member",
    fictionalRecordConfirmed: true,
    member: {
      firstName: "Flockbot",
      lastName: "Verification",
      email: "controlled-record@example.test",
    },
  };
}
function execution() {
  return {
    identifyTarget: vi.fn<VerificationExecution["identifyTarget"]>(
      async () => ({
        ...target,
        authenticated: true,
      }),
    ),
    listGroups: vi.fn<VerificationExecution["listGroups"]>(async () => [
      { id: "102" },
    ]),
    addMember: vi.fn<VerificationExecution["addMember"]>(async () => ({
      success: true,
    })),
  };
}

describe("isolated verification guard", () => {
  it("keeps the checked-in example inert before any execution call", async () => {
    const config: unknown = JSON.parse(
      readFileSync(
        new URL(
          "../../scripts/zapier/verification-config.example.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const f = execution();
    await expect(runIsolatedVerification(config, f)).rejects.toMatchObject({
      code: "consent_required",
    });
    expect(f.identifyTarget).not.toHaveBeenCalled();
    expect(f.listGroups).not.toHaveBeenCalled();
    expect(f.addMember).not.toHaveBeenCalled();
  });

  it.each([
    [undefined, "invalid_verification_config"],
    [{}, "consent_required"],
    [{ ...request(), consent: false }, "consent_required"],
    [{ ...request(), subdomain: undefined }, "invalid_verification_config"],
    [
      { ...request(), subdomain: "other.test/path" },
      "invalid_verification_config",
    ],
    [{ ...request(), expectedNetworkId: "" }, "invalid_verification_config"],
    [
      { ...request(), testOnlyLoginConfirmed: false },
      "invalid_verification_config",
    ],
    [{ ...request(), allowedGroupIds: [] }, "invalid_verification_config"],
    [{ ...request(), groupId: "999" }, "group_not_allowlisted"],
    [
      { ...request(), operation: "send-message" },
      "invalid_verification_config",
    ],
    [
      { ...request(), fictionalRecordConfirmed: false },
      "invalid_verification_config",
    ],
    [
      { ...request(), member: { ...request().member, email: "bad" } },
      "invalid_verification_config",
    ],
    [
      {
        ...request(),
        member: { ...request().member, mobilePhone: "+12025550123" },
      },
      "invalid_verification_config",
    ],
  ])(
    "refuses unsafe configuration before any execution call %#",
    async (input, code) => {
      const f = execution();
      await expect(runIsolatedVerification(input, f)).rejects.toMatchObject({
        name: "VerificationError",
        code,
        outcome: "not_submitted",
      });
      expect(f.identifyTarget).not.toHaveBeenCalled();
      expect(f.listGroups).not.toHaveBeenCalled();
      expect(f.addMember).not.toHaveBeenCalled();
    },
  );

  it.each([
    [null, "target_unconfirmed"],
    [{ ...target, authenticated: false }, "target_unconfirmed"],
    [{ ...target, authenticated: true, networkId: "999" }, "target_mismatch"],
    [
      {
        ...target,
        authenticated: true,
        origin: "https://another-parish.flocknote.com",
      },
      "target_mismatch",
    ],
  ])(
    "allows only identification when target evidence fails %#",
    async (evidence, code) => {
      const f = execution();
      f.identifyTarget.mockResolvedValue(evidence as TargetEvidence | null);
      await expect(runIsolatedVerification(request(), f)).rejects.toMatchObject(
        { code, outcome: "not_submitted" },
      );
      expect(f.identifyTarget).toHaveBeenCalledExactlyOnceWith(target);
      expect(f.listGroups).not.toHaveBeenCalled();
      expect(f.addMember).not.toHaveBeenCalled();
    },
  );

  it("sanitizes an unconfirmed login/network read and makes no later request", async () => {
    const f = execution();
    f.identifyTarget.mockRejectedValue(
      new Error(
        "fictional-password fictional-cookie controlled-record@example.test",
      ),
    );
    const error = await runIsolatedVerification(request(), f).catch(
      (e: unknown) => e,
    );
    expect(error).toMatchObject({
      code: "target_unconfirmed",
      outcome: "not_submitted",
    });
    expect(
      [String(error), inspect(error), JSON.stringify(error)].join(),
    ).not.toMatch(/fictional-password|fictional-cookie|controlled-record/);
    expect(f.identifyTarget).toHaveBeenCalledOnce();
    expect(f.listGroups).not.toHaveBeenCalled();
    expect(f.addMember).not.toHaveBeenCalled();
  });

  it("refuses an allowlisted group absent from the confirmed network", async () => {
    const f = execution();
    f.listGroups.mockResolvedValue([{ id: "103" }]);
    await expect(runIsolatedVerification(request(), f)).rejects.toMatchObject({
      code: "group_unavailable",
      outcome: "not_submitted",
    });
    expect(f.identifyTarget).toHaveBeenCalledOnce();
    expect(f.listGroups).toHaveBeenCalledExactlyOnceWith(target);
    expect(f.addMember).not.toHaveBeenCalled();
  });

  it("does not write after a group read fails", async () => {
    const f = execution();
    f.listGroups.mockRejectedValue(new Error("fictional-cookie"));
    await expect(runIsolatedVerification(request(), f)).rejects.toMatchObject({
      code: "verification_read_failed",
      outcome: "not_submitted",
    });
    expect(f.identifyTarget).toHaveBeenCalledOnce();
    expect(f.listGroups).toHaveBeenCalledOnce();
    expect(f.addMember).not.toHaveBeenCalled();
  });

  it("limits a read-only run to identification and one group read", async () => {
    const f = execution();
    const result = await runIsolatedVerification(
      { ...request(), operation: "read-groups" },
      f,
    );
    expect(result).toEqual({ verified: true, writeConfirmed: false });
    expect(f.identifyTarget).toHaveBeenCalledOnce();
    expect(f.listGroups).toHaveBeenCalledOnce();
    expect(f.addMember).not.toHaveBeenCalled();
  });

  it("submits one explicitly selected fictional record only after identity and group checks", async () => {
    const f = execution();
    const input = request();
    const result = await runIsolatedVerification(input, f);
    expect(f.identifyTarget.mock.invocationCallOrder[0]).toBeLessThan(
      f.listGroups.mock.invocationCallOrder[0] as number,
    );
    expect(f.listGroups.mock.invocationCallOrder[0]).toBeLessThan(
      f.addMember.mock.invocationCallOrder[0] as number,
    );
    expect(f.addMember).toHaveBeenCalledExactlyOnceWith(
      target,
      "102",
      input.member,
    );
    expect(result).toEqual({ verified: true, writeConfirmed: true });
    expect(JSON.stringify(result)).not.toMatch(/example|Verification|501|102/);
  });

  it("snapshots target, allowlist, member and callbacks across identification", async () => {
    const f = execution();
    const input = request();
    const original = { ...input.member };
    f.identifyTarget.mockImplementation(async (expected) => {
      expect(Object.isFrozen(expected)).toBe(true);
      input.subdomain = "another-parish";
      input.expectedNetworkId = "999";
      input.groupId = "999";
      input.allowedGroupIds.splice(0, 1, "999");
      input.member.email = "changed@example.test";
      f.addMember = vi.fn(async () => {
        throw new Error("Replaced callback.");
      });
      return { ...target, authenticated: true };
    });
    const originalAdd = f.addMember;
    await expect(runIsolatedVerification(input, f)).resolves.toEqual({
      verified: true,
      writeConfirmed: true,
    });
    expect(originalAdd).toHaveBeenCalledExactlyOnceWith(
      target,
      "102",
      original,
    );
    expect(Object.isFrozen(originalAdd.mock.calls[0]?.[2])).toBe(true);
    expect(f.addMember).not.toHaveBeenCalled();
  });

  it.each([
    [new Error("fictional-cookie"), "unknown", undefined],
    [
      new FlockbotError("operation_timeout", undefined, "unknown"),
      "unknown",
      "operation_timeout",
    ],
    [
      new FlockbotError("credentials_unavailable", undefined, "not_submitted"),
      "not_submitted",
      "credentials_unavailable",
    ],
  ])(
    "never replays a failed write and retains the safe outcome %#",
    async (failure, outcome, upstreamCode) => {
      const f = execution();
      f.addMember.mockRejectedValue(failure);
      await expect(runIsolatedVerification(request(), f)).rejects.toMatchObject(
        { code: "verification_write_failed", outcome, upstreamCode },
      );
      expect(f.identifyTarget).toHaveBeenCalledOnce();
      expect(f.listGroups).toHaveBeenCalledOnce();
      expect(f.addMember).toHaveBeenCalledOnce();
    },
  );

  it("never reports an unconfirmed write response as success", async () => {
    const f = execution();
    f.addMember.mockResolvedValue({ success: false } as unknown as {
      success: true;
    });
    await expect(runIsolatedVerification(request(), f)).rejects.toMatchObject({
      code: "verification_write_failed",
      outcome: "unknown",
    });
    expect(f.addMember).toHaveBeenCalledOnce();
  });
});
