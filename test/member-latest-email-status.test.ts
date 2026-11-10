import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import {
  EmailAnalytics,
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
      if (path.startsWith("group/")) throw new Error("Listing must use GET");
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

describe.each(["engagement", "aggregate"] as const)(
  "%s selection from published-note JSON",
  (consumer) => {
    const read = (f: ReturnType<typeof fixture>) =>
      consumer === "engagement"
        ? f.read()
        : new EmailAnalytics({ groupId: "101" }).read(
            f.context,
            new Network("example-parish"),
          );

    it("selects using one JSON listing without requiring a success flag or HTML", async () => {
      const f = fixture();
      expect(await read(f)).toMatchObject({
        selection: "selected",
        email: { id: "801", publishedDate: 1800000000 },
        reason: null,
        ...(consumer === "engagement"
          ? { engagement: "recorded_open" }
          : { counts: { opened: 17 } }),
      });
      expect(f.requests).toEqual([
        "group/101/notes?ajax&more",
        "note/801/analyticsSummary?ajax",
        "note/801/analytics2?ajax",
        ...(consumer === "engagement"
          ? ["user/301/profile", "note/801/searchAnalytics?ajax"]
          : []),
      ]);
    });

    it("keeps unexpected statuses, invalid dates and duplicate IDs unknown without skipping rows", async () => {
      for (const row of [
        ...[undefined, "draft", "autosaved", "scheduled", "unknown"].map(
          // An older trailing row must fail on status, not merely on ordering.
          (status) => ({ ID: 901, publishedDate: 1600000000, status }),
        ),
        ...[
          undefined,
          0,
          -1,
          1.5,
          "1900000000",
          Number.MAX_SAFE_INTEGER + 1,
        ].map((publishedDate) => ({
          ID: 901,
          publishedDate,
          status: "published",
        })),
        { ID: "00801", publishedDate: 1600000000, status: "published" },
      ]) {
        for (const position of ["before", "after"]) {
          const f = fixture();
          const listing = f.data["group/101/notes?ajax&more"];
          f.responses["group/101/notes?ajax&more"] = {
            ...listing,
            notes:
              position === "before"
                ? [row, ...listing.notes]
                : [...listing.notes, row],
          };
          expect(await read(f)).toMatchObject({
            selection: "unknown",
            email: null,
            reason: "selection_ambiguous",
            ...(consumer === "engagement"
              ? { engagement: "unknown" }
              : { counts: null }),
          });
          expect(f.requests).toEqual(["group/101/notes?ajax&more"]);
        }
      }
    });

    it("requires an unambiguous newest timestamp and enough of the first page", async () => {
      for (const [dates, more, reason] of [
        [[], false, "selection_unavailable"],
        [[1800000000], true, "selection_ambiguous"],
        [[1800000000, 1800000000], false, "selection_ambiguous"],
        [[1800000000, 1900000000], true, "selection_ambiguous"],
        [[1800000000, 1600000000, 1700000000], false, "selection_ambiguous"],
      ] as const) {
        const f = fixture();
        f.responses["group/101/notes?ajax&more"] = {
          groupID: 101,
          more,
          notes: dates.map((publishedDate, i) => ({
            ID: 801 - i,
            publishedDate,
            status: "published",
          })),
        };
        expect(await read(f)).toMatchObject({
          selection: "unknown",
          email: null,
          reason,
        });
        expect(f.requests).toEqual(["group/101/notes?ajax&more"]);
      }
      const f = fixture();
      f.data["group/101/notes?ajax&more"].notes.pop();
      f.data["group/101/notes?ajax&more"].more = false;
      expect(await read(f)).toMatchObject({
        selection: "selected",
        email: { id: "801" },
      });
    });

    it("keeps inconsistent note metadata and unsupported send history unknown", async () => {
      const data = latestEmailResponses();
      const summary = data["note/801/analyticsSummary?ajax"];
      const analytics = data["note/801/analytics2?ajax"];
      const cases: [string, unknown, string][] = [
        ...[
          { ID: "802" },
          { dateTime: 1900000000 },
          { noteTargets: [{ groupID: 999 }] },
          { noteTargets: [{}] },
        ].map((note): [string, unknown, string] => [
          "note/801/analyticsSummary?ajax",
          { ...summary, note: { ...summary.note, ...note } },
          "inconsistent_email_metadata",
        ]),
        ...[{ ID: "802" }, { type: "sms" }, { dateTime: 1900000000 }].map(
          (note): [string, unknown, string] => [
            "note/801/analytics2?ajax",
            { ...analytics, note: { ...analytics.note, ...note } },
            "inconsistent_email_metadata",
          ],
        ),
        ...[
          [{ fromDate: 1800000000 }, { fromDate: 1900000000 }],
          [{ fromDate: 1900000000 }],
        ].map((sendingSummary): [string, unknown, string] => [
          "note/801/analytics2?ajax",
          { ...analytics, sendingSummary },
          "unsupported_send_history",
        ]),
      ];
      for (const [path, response, reason] of cases) {
        const f = fixture();
        f.responses[path] = response;
        expect(await read(f)).toMatchObject({
          selection: "unknown",
          email: null,
          reason,
          ...(consumer === "engagement"
            ? { engagement: "unknown" }
            : { counts: null }),
        });
        expect(f.requests).toEqual([
          "group/101/notes?ajax&more",
          "note/801/analyticsSummary?ajax",
          ...(path.includes("analytics2") ? [path] : []),
        ]);
      }
    });

    it("rejects malformed target and send-history containers with a specific reason", async () => {
      for (const value of [null, {}]) {
        for (const [path, reason] of [
          ["note/801/analyticsSummary?ajax", "note_targets_shape"],
          ["note/801/analytics2?ajax", "sending_summary_shape"],
        ] as const) {
          const f = fixture();
          const summary = f.data["note/801/analyticsSummary?ajax"];
          f.responses[path] =
            reason === "note_targets_shape"
              ? { ...summary, note: { ...summary.note, noteTargets: value } }
              : {
                  ...f.data["note/801/analytics2?ajax"],
                  sendingSummary: value,
                };
          await expect(read(f)).rejects.toMatchObject({
            code: "invalid_response",
            reason,
          });
          expect(f.requests).toEqual([
            "group/101/notes?ajax&more",
            "note/801/analyticsSummary?ajax",
            ...(path.includes("analytics2") ? [path] : []),
          ]);
        }
      }
    });
  },
);

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

  it("ignores presentation fields rather than treating them as selection metadata", async () => {
    const f = fixture();
    Object.assign(f.data["group/101/notes?ajax&more"].notes[0]!, {
      title: "Draft",
      date: "Scheduled",
      summary: '<script>throw new Error("PRIVATE SCRIPT")</script>',
    });
    expect(await f.read()).toMatchObject({
      email: { id: "801" },
      engagement: "recorded_open",
    });
  });

  it("rejects malformed listings and mismatched groups instead of inventing selection metadata", async () => {
    const listing = latestEmailResponses()["group/101/notes?ajax&more"];
    for (const [response, reason] of [
      ["<form>PRIVATE LOGIN</form>", "expected_object"],
      [null, "expected_object"],
      [[], "expected_object"],
      [{ ...listing, groupID: 999 }, "group_identity_mismatch"],
      [{ ...listing, notes: null }, "expected_notes_array"],
      [{ ...listing, notes: {} }, "expected_notes_array"],
      [{ ...listing, notes: [null] }, "expected_object"],
      ...[undefined, "true", 1].map((more) => [
        { ...listing, more },
        "expected_pagination_boolean",
      ]),
    ]) {
      const f = fixture();
      f.responses["group/101/notes?ajax&more"] = response;
      await expect(f.read()).rejects.toMatchObject({
        code: "invalid_response",
        reason,
      });
      expect(f.requests).toEqual(["group/101/notes?ajax&more"]);
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
