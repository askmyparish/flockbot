import { inspect } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { MemberProfile } from "../src/models/member-profile.js";
import type { MemberField } from "../src/models/member-fields.js";
import { profileResponse } from "./fixtures/member-profile.js";

function fixture() {
  const data: Record<string, unknown> = profileResponse();
  const info = data.userInfo as Record<string, unknown>;
  const context = {
    check: vi.fn(),
    read: vi.fn(async (): Promise<unknown> => {
      throw new Error("Unexpected GET");
    }),
    query: vi.fn(async (): Promise<unknown> => data),
  };
  const read = async (fields?: readonly MemberField[]) =>
    new MemberProfile("301", fields).read(context);
  return { data, info, context, read };
}

describe("selected member profile reads", () => {
  it("returns identity only by default, validates the subject and ignores the viewer ID", async () => {
    const f = fixture();
    expect(await f.read()).toEqual({
      id: "301",
      firstName: "Alex",
      lastName: "Rivera",
    });
    expect(f.context.query).toHaveBeenCalledExactlyOnceWith("user/301/profile");
    expect(f.context.read).not.toHaveBeenCalled();
  });

  it("selects only the stored email and accurate verification/bad-address flags", async () => {
    const f = fixture();
    f.data.error = "fictional-profile-warning";
    f.info.message = "contact-edit-warning";
    const result = await f.read(["email"]);
    expect(result).toEqual({
      id: "301",
      firstName: "Alex",
      lastName: "Rivera",
      email: {
        value: "alex@example.test",
        verified: false,
        isBadEmail: true,
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/555|pending|canEdit|warning/);
    // Captured canEditContactInfo:false does not deny this authorized read.
    expect(f.info.canEditContactInfo).toBe(false);
  });

  it("selects mobile phone independently and preserves observed null", async () => {
    const f = fixture();
    expect(await f.read(["mobilePhone"])).toEqual({
      id: "301",
      firstName: "Alex",
      lastName: "Rivera",
      mobilePhone: {
        value: "+1 (202) 555-0123",
        verified: true,
      },
    });
    f.info.mobilePhone = null;
    f.info.mobilePhoneVerified = false;
    expect(await f.read(["mobilePhone"])).toMatchObject({
      mobilePhone: { value: null, verified: false },
    });
  });

  it("handles simulated missing/pending contacts without inventing or substituting values", async () => {
    const f = fixture();
    delete f.info.email;
    f.info.pendingEmail = "pending@example.test";
    f.info.mobilePhone = " ";
    f.info.pendingMobilePhone = "+1 (202) 555-0199";
    const value = await f.read(["email", "mobilePhone"]);
    expect(value).toEqual({
      id: "301",
      firstName: "Alex",
      lastName: "Rivera",
      unavailableFields: ["email"],
      mobilePhone: { value: null, verified: true },
    });
    expect(JSON.stringify(value)).not.toMatch(/pending@|0199/);
  });

  it("keeps a simulated null stored email distinct from an omitted field", async () => {
    const f = fixture();
    f.info.email = null;
    expect(await f.read(["email"])).toMatchObject({
      email: { value: null, verified: false, isBadEmail: true },
    });
    expect(await f.read(["email"])).not.toHaveProperty("unavailableFields");
  });

  it.each([
    { where: "top", field: "isInCurrentNet" },
    { where: "top", field: "canViewProfile" },
    { where: "user", field: "canViewProfile" },
  ])(
    "rejects explicit view/parish denial ($where.$field)",
    async ({ where, field }) => {
      const f = fixture();
      (where === "top" ? f.data : f.info)[field] = false;
      await expect(f.read(["email"])).rejects.toMatchObject({
        code: "permission_denied",
      });
    },
  );

  it.each([
    { where: "top", field: "isInCurrentNet", value: undefined },
    { where: "top", field: "canViewProfile", value: 1 },
    { where: "user", field: "canViewProfile", value: "true" },
    { where: "user", field: "userID", value: 302 },
    { where: "user", field: "userID", value: 0 },
    { where: "user", field: "firstName", value: null },
    { where: "user", field: "email", value: 123 },
    { where: "user", field: "emailVerified", value: "false" },
    { where: "user", field: "isBadEmail", value: undefined },
    { where: "user", field: "mobilePhoneVerified", value: 1 },
  ])(
    "rejects malformed profile values ($where.$field)",
    async ({ where, field, value }) => {
      const f = fixture();
      (where === "top" ? f.data : f.info)[field] = value;
      await expect(f.read(["email", "mobilePhone"])).rejects.toMatchObject({
        code: "invalid_response",
      });
    },
  );

  it("validates/snapshots arguments without any request or default inspection exposure", () => {
    for (const id of ["0", "../301", "x".repeat(129)])
      expect(() => new MemberProfile(id)).toThrow(/invalid_input/);
    const fields: MemberField[] = ["email"];
    const profile = new MemberProfile("000301", fields);
    fields.push("mobilePhone");
    expect(profile.toInput()).toEqual({ userId: "301", fields: ["email"] });
    expect(inspect(profile)).not.toContain("301");
    expect(JSON.stringify(profile)).not.toContain("301");
    expect(Object.keys(profile)).toEqual([]);
    expect(() => new MemberProfile("301", ["email", "email"])).toThrow(
      /invalid_input/,
    );
  });

  it("keeps rejection, cancellation and malformed envelopes out of successful results", async () => {
    const rejected = fixture();
    rejected.data.success = false;
    await expect(rejected.read()).rejects.toMatchObject({
      code: "upstream_rejected",
    });
    const malformed = fixture();
    malformed.data.userInfo = null;
    await expect(malformed.read()).rejects.toMatchObject({
      code: "invalid_response",
    });
    const cancelled = fixture();
    cancelled.context.check.mockImplementation(() => {
      throw new Error("cancelled");
    });
    await expect(cancelled.read()).rejects.toThrow("cancelled");
    expect(cancelled.context.query).not.toHaveBeenCalled();
  });
});
