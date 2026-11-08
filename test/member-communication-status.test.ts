import { describe, expect, it } from "vitest";
import {
  MemberCommunicationStatus,
  type MemberCommunicationInput,
} from "../src/models/member-communication-status.js";
import { Network } from "../src/models/network.js";
import { profileResponse } from "./fixtures/member-profile.js";
import { membershipResponse, membershipRow } from "./fixtures/member-groups.js";

function fixture() {
  const profile = profileResponse();
  const info: Record<string, unknown> = profile.userInfo;
  info.stopReplyData = {
    isStopReplied: false,
    stopReplyPhone: "PRIVATE-STOP-PHONE",
  };
  const groups = membershipResponse();
  const selectedRow = membershipRow();
  groups.data.subscribedGroups[1] = selectedRow;
  const row: Record<string, unknown> = selectedRow;
  const context = {
    check() {},
    async read(): Promise<unknown> {
      throw new Error("Unexpected GET");
    },
    async query(path: string): Promise<unknown> {
      if (path === "user/301/profile") return profile;
      if (path === "user/301/groups") return groups;
      throw new Error("Unexpected request");
    },
  };
  const read = (input: Partial<MemberCommunicationInput> = {}) =>
    new MemberCommunicationStatus({
      userId: "301",
      groupId: "102",
      ...input,
    }).read(context, new Network("example-parish"));
  return { profile, info, groups, row, read };
}

describe("member communication diagnostics", () => {
  it("keeps enabled preferences separate from bad/unverified contacts without disclosing values", async () => {
    const f = fixture();
    expect(await f.read()).toEqual({
      userId: "301",
      groupId: "102",
      groupName: "Choir",
      membership: "member",
      email: {
        preference: "enabled",
        contactPresent: true,
        verified: false,
        isBadEmail: true,
      },
      sms: {
        preference: "disabled",
        contactPresent: true,
        verified: true,
        stopReplied: false,
      },
      warnings: [
        "email_contact_unverified",
        "sms_preference_disabled",
        "email_flagged_bad",
      ],
      limitations: [
        "Suppressions are not assessed; settings do not establish delivery.",
        "Group visibility may be incomplete. Separate reads are not an atomic snapshot.",
      ],
    });
    expect(JSON.stringify(await f.read())).not.toMatch(
      /alex@|555|PRIVATE|pending|userInfo|firstName/,
    );
    const selected = await f.read({ fields: ["email"] });
    expect(selected.email.value).toBe("alex@example.test");
    expect(selected.sms).not.toHaveProperty("value");
    const mobile = await f.read({ fields: ["mobilePhone"] });
    expect(mobile.sms.value).toBe("+1 (202) 555-0123");
    expect(mobile.email).not.toHaveProperty("value");
  });

  it("distinguishes absent diagnostic facts from false, null contacts and disabled preferences", async () => {
    const f = fixture();
    for (const key of ["email", "emailVerified", "isBadEmail", "stopReplyData"])
      delete f.info[key];
    delete f.row.emailPref;
    f.info.pendingEmail = "pending@example.test";
    f.info.mobilePhone = null;
    f.info.mobilePhoneVerified = false;
    expect(await f.read({ fields: ["email", "mobilePhone"] })).toMatchObject({
      email: {
        preference: "unknown",
        contactPresent: null,
        verified: null,
        isBadEmail: null,
      },
      sms: {
        preference: "disabled",
        contactPresent: false,
        verified: false,
        stopReplied: null,
        value: null,
      },
      warnings: [
        "sms_preference_disabled",
        "sms_contact_missing",
        "sms_contact_unverified",
      ],
    });
    expect((await f.read({ fields: ["email"] })).email).not.toHaveProperty(
      "value",
    );
    f.info.email = null;
    f.info.emailVerified = true;
    f.info.isBadEmail = false;
    f.row.emailPref = 1;
    f.info.stopReplyData = {
      isStopReplied: true,
      stopReplyPhone: "PRIVATE-STOP-PHONE",
    };
    const result = await f.read({ fields: ["email"] });
    expect(result.email).toEqual({
      preference: "enabled",
      contactPresent: false,
      verified: true,
      isBadEmail: false,
      value: null,
    });
    expect(result.warnings).toContain("sms_stop_reported");
    expect(JSON.stringify(result)).not.toContain("PRIVATE-STOP-PHONE");
  });

  it("checks beyond 50 rows and keeps explicit false and absent relationships distinct", async () => {
    const f = fixture();
    f.groups.data.subscribedGroups = Array.from({ length: 63 }, (_, i) =>
      membershipRow(1000 + i, `Group ${i}`),
    );
    const target = membershipRow(1063, "Group 63");
    target.smsPref = 1;
    f.groups.data.subscribedGroups.push(target);
    expect(await f.read({ groupId: "1063" })).toMatchObject({
      membership: "member",
      sms: { preference: "enabled" },
    });
    target.isSubscribed = false;
    expect(await f.read({ groupId: "1063" })).toMatchObject({
      membership: "not_member",
    });
    expect(await f.read({ groupId: "1064" })).toMatchObject({
      membership: "unknown",
      email: { preference: "unknown" },
      sms: { preference: "unknown" },
    });
  });

  it.each([
    ["profile", "emailVerified", "false"],
    ["profile", "mobilePhoneVerified", 1],
    ["profile", "isBadEmail", null],
    ["profile", "email", 42],
    ["profile", "stopReplyData", null],
    ["profile", "stopReplyData", { isStopReplied: "false" }],
    ["group", "emailPref", 2],
    ["group", "smsPref", "0"],
    ["group", "emailPref", null],
  ])(
    "rejects malformed %s.%s rather than inventing facts",
    async (source, key, value) => {
      const f = fixture();
      (source === "profile" ? f.info : f.row)[String(key)] = value;
      await expect(f.read()).rejects.toMatchObject({
        code: "invalid_response",
      });
    },
  );

  it("does not turn an empty warnings list into a delivery verdict", async () => {
    const f = fixture();
    f.info.emailVerified = true;
    f.info.isBadEmail = false;
    f.row.smsPref = 1;
    const result = await f.read();
    expect(result.warnings).toEqual([]);
    expect(result.limitations.join(" ")).toContain("do not establish delivery");
    expect(result).not.toHaveProperty("deliverable");
  });
});
