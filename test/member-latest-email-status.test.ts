import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import {
  FlockbotError,
  MemberLatestEmailStatus,
  Network,
  type MemberLatestEmailResult,
} from "../src/index.js";
import { latestEmailResponses } from "./fixtures/latest-email.js";

function fixture() {
  const data = latestEmailResponses();
  const responses: Record<string, unknown> = data;
  const requests: string[] = [];
  const context = {
    check() {},
    async read(path: string) {
      requests.push(path);
      if (!Object.hasOwn(responses, path))
        throw new Error("Unexpected fictional read");
      const value = responses[path];
      if (value instanceof Error) throw value;
      return value;
    },
    async query(path: string, body?: string) {
      if (
        path.startsWith("group/") &&
        body !== "preferredBoardUrl=&preferredPanelType=notes"
      )
        throw new Error("Incorrect notes panel");
      if (path.includes("searchAnalytics") && body !== "s=Rivera")
        throw new Error("Incorrect analytics query");
      return this.read(path);
    },
  };
  const lookup = new MemberLatestEmailStatus({ userId: "301", groupId: "101" });
  const read = (): Promise<MemberLatestEmailResult> =>
    lookup.read(context, new Network("example-parish"));
  return { data, responses, context, requests, lookup, read };
}

describe("latest distinct group email engagement", () => {
  it("matches stable identity rather than the first surname match and exposes only qualified facts", async () => {
    const f = fixture();
    const opened = await f.read();
    expect(opened).toMatchObject({
      userId: "301",
      groupId: "101",
      selection: "selected",
      email: { id: "801", publishedDate: 1800000000 },
      engagement: "recorded_open",
      reason: null,
    });
    expect(Number.isNaN(Date.parse(opened.observedAt))).toBe(false);
    expect(opened.limitations.join(" ")).toContain(
      "does not prove human reading",
    );
    expect(JSON.stringify(opened)).not.toMatch(
      /Rivera|Alex|example.test|PRIVATE|Author|<div|userInfo/,
    );
    f.data["note/801/searchAnalytics?ajax"].results[1]!.status = "unopened";
    expect(await f.read()).toMatchObject({
      engagement: "reported_unopened",
      reason: null,
    });
    expect(JSON.stringify(f.lookup)).not.toContain("301");
    expect(inspect(f.lookup)).not.toContain("301");
    expect(f.lookup.toInput()).toEqual({ userId: "301", groupId: "101" });
  });

  it("retains the newest email when the member is absent instead of selecting an older email", async () => {
    const f = fixture();
    f.data["note/801/searchAnalytics?ajax"].results.splice(1, 1);
    expect(await f.read()).toMatchObject({
      selection: "selected",
      email: { id: "801" },
      engagement: "unknown",
      reason: "member_not_in_search_results",
    });
    expect(f.requests.some((path) => path.includes("note/800"))).toBe(false);
  });

  it("does not turn duplicates, proxy mappings or unsupported status into a verdict", async () => {
    const f = fixture();
    const response = f.data["note/801/searchAnalytics?ajax"];
    response.results.push({ ...response.results[1]!, status: "unopened" });
    expect(await f.read()).toMatchObject({
      engagement: "unknown",
      reason: "ambiguous_member_status",
    });
    response.results.pop();
    Object.assign(response.results[1]!, { targetContacts: [{ userID: 999 }] });
    expect(await f.read()).toMatchObject({
      engagement: "unknown",
      reason: "unsupported_member_status",
    });
    Object.assign(response.results[1]!, {
      targetContacts: [],
      status: "bounced",
    });
    expect(await f.read()).toMatchObject({
      engagement: "unknown",
      reason: "unsupported_member_status",
    });
  });

  it("keeps short surnames unknown rather than inventing an ID search", async () => {
    const f = fixture();
    f.data["user/301/profile"].userInfo.lastName = "Li";
    expect(await f.read()).toMatchObject({
      selection: "selected",
      engagement: "unknown",
      reason: "unsupported_member_query",
    });
    expect(f.requests.some((p) => p.includes("searchAnalytics"))).toBe(false);
  });

  it.each(["sms", "scheduled", "draft"])(
    "does not skip an unsupported newest %s note to guess an older email",
    async (type) => {
      const f = fixture();
      f.data["note/801/analyticsSummary?ajax"].note.type = type;
      expect(await f.read()).toMatchObject({
        selection: "unknown",
        email: null,
        engagement: "unknown",
        reason: "unsupported_latest_note",
      });
      expect(
        f.requests.some((p) => p.includes("profile") || p.includes("note/800")),
      ).toBe(false);
    },
  );

  it("does not promote resend activity or accept inconsistent note/group metadata", async () => {
    const f = fixture();
    f.data["note/801/analytics2?ajax"].sendingSummary.push({
      fromDate: 1900000000,
    });
    expect(await f.read()).toMatchObject({
      selection: "unknown",
      reason: "unsupported_send_history",
    });
    f.data["note/801/analytics2?ajax"].sendingSummary.pop();
    f.data["note/801/analyticsSummary?ajax"].note.noteTargets[0]!.groupID = 999;
    expect(await f.read()).toMatchObject({
      selection: "unknown",
      reason: "inconsistent_email_metadata",
    });
    f.data["note/801/analyticsSummary?ajax"].note.noteTargets[0]!.groupID = 101;
    f.data["note/801/analytics2?ajax"].note.dateTime = 1900000000;
    expect(await f.read()).toMatchObject({
      selection: "unknown",
      reason: "inconsistent_email_metadata",
    });
  });

  it("rejects ambiguous ordering and ignores script/template impostors without executing them", async () => {
    const f = fixture();
    const html = f.data["group/101?ajax"];
    for (const date of ["1800000000", "1900000000"]) {
      f.data["group/101?ajax"] = html.replace("1700000000", date);
      expect(await f.read()).toMatchObject({
        selection: "unknown",
        reason: "selection_ambiguous",
      });
    }
    f.data["group/101?ajax"] = html.replace(
      '<div class="holder">',
      '<div class="holder"><template><div class="note_list_item" data-noteid="999" data-date="9999999999"></div></template><script>throw new Error("PRIVATE SCRIPT")</script>',
    );
    expect(await f.read()).toMatchObject({
      email: { id: "801" },
      engagement: "recorded_open",
    });
    f.data["group/101?ajax"] = html.replace("Sent by", "Draft by");
    expect(await f.read()).toMatchObject({
      selection: "unknown",
      reason: "unsupported_latest_note",
    });
  });

  it("keeps empty supported panels unknown and rejects unrelated or malformed HTML", async () => {
    const f = fixture();
    f.data["group/101?ajax"] =
      '<div class="page_group" data-groupid="101"><div class="page_notes"></div></div>';
    expect(await f.read()).toMatchObject({
      email: null,
      reason: "selection_unavailable",
    });
    for (const html of [
      "<form>PRIVATE LOGIN</form>",
      '<div class="page_group" data-groupid="999"></div>',
    ]) {
      f.data["group/101?ajax"] = html;
      await expect(f.read()).rejects.toMatchObject({
        code: "invalid_response",
      });
    }
  });

  it("propagates malformed, denied and cancelled reads instead of reporting unopened", async () => {
    const f = fixture();
    f.responses["note/801/searchAnalytics?ajax"] = {
      success: true,
      s: "Rivera",
      results: [{ userID: 301, status: "opened" }],
    };
    await expect(f.read()).rejects.toMatchObject({ code: "invalid_response" });
    f.responses["note/801/searchAnalytics?ajax"] = new FlockbotError(
      "permission_denied",
    );
    await expect(f.read()).rejects.toMatchObject({ code: "permission_denied" });
    f.context.check = () => {
      throw new FlockbotError("operation_cancelled");
    };
    await expect(f.read()).rejects.toMatchObject({
      code: "operation_cancelled",
    });
  });
});
