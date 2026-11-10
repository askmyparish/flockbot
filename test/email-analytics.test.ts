import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import {
  EmailAnalytics,
  FlockbotError,
  Network,
  type EmailAnalyticsInput,
} from "../src/index.js";
import { latestEmailResponses } from "./fixtures/latest-email.js";

function fixture() {
  const data = latestEmailResponses();
  const responses: Record<string, unknown> = {
    ...data,
    dashboard: '<div id="fnReactHolder"></div>',
    "navigation/groups": { groups: [] },
    "network/getMetadata": { everyoneGroupID: 101 },
  };
  const requests: string[] = [];
  const network = new Network("example-parish");
  const context = {
    check() {},
    async read(path: string) {
      requests.push(path);
      if (!Object.hasOwn(responses, path))
        throw new Error("Unexpected fictional read");
      const response = responses[path];
      if (response instanceof Error) throw response;
      return response;
    },
  };
  return {
    data,
    responses,
    context,
    network,
    requests,
    set(value: unknown) {
      responses["note/801/analyticsSummary?ajax"] = value;
    },
    read: (input: EmailAnalyticsInput = { emailId: "801" }) =>
      new EmailAnalytics(input).read(context, network),
  };
}

describe("email aggregate analytics", () => {
  it("snapshots an explicit older email and preserves asymmetric counters without arithmetic assumptions", async () => {
    const f = fixture();
    const input = { emailId: "00801" };
    const lookup = new EmailAnalytics(input);
    input.emailId = "999";
    const summary = latestEmailResponses()["note/801/analyticsSummary?ajax"];
    Object.assign(summary.note, {
      title: "PRIVATE",
      author: "private@example.test",
    });
    Object.assign(summary.counts, {
      total: 6,
      recipients: ["private@example.test"],
    });
    f.set(summary);
    const result = await lookup.read(f.context, f.network);
    expect(result).toMatchObject({
      requested: { emailId: "801" },
      selection: "selected",
      email: { id: "801", publishedDate: 1800000000 },
      reason: null,
    });
    expect(result.counts).toEqual({
      opened: 17,
      unopened: 9,
      bounced: 2,
      complaint: 0,
      sms: 3,
      total: 6,
      voicecalls: 1,
      clicks: 5,
      unsubscribes: 4,
    });
    expect(f.requests).toEqual(["note/801/analyticsSummary?ajax"]);
    expect(Number.isNaN(Date.parse(result.observedAt))).toBe(false);
    expect(result.limitations.join(" ")).toContain(
      "not a partition of unique recipients",
    );
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|private@|author|title/);
    expect(JSON.stringify(lookup)).not.toContain("801");
    expect(inspect(lookup)).not.toContain("801");
  });

  it("distinguishes zero from missing/null categories and rejects invented counters", async () => {
    const f = fixture();
    const summary = latestEmailResponses()["note/801/analyticsSummary?ajax"];
    f.set({
      ...summary,
      counts: { opened: 0, unopened: null, privateValue: "PRIVATE" },
    });
    expect((await f.read()).counts).toEqual({
      opened: 0,
      unopened: null,
      bounced: null,
      complaint: null,
      sms: null,
      total: null,
      voicecalls: null,
      clicks: null,
      unsubscribes: null,
    });
    f.set({ ...summary, counts: { opened: null } });
    expect((await f.read()).counts?.opened).toBeNull();
    for (const counts of [
      undefined,
      null,
      [],
      {},
      { invented: 3 },
      { opened: "0" },
      { opened: -1 },
      { opened: 0.5 },
      { opened: Number.MAX_SAFE_INTEGER + 1 },
      { opened: NaN },
      { opened: undefined },
    ]) {
      f.set({ ...summary, counts });
      await expect(f.read()).rejects.toMatchObject({
        code: "invalid_response",
      });
    }
    f.set({ ...summary, counts: { opened: Number.MAX_SAFE_INTEGER } });
    expect((await f.read()).counts?.opened).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("does not substitute emails or turn non-email and failed responses into counts", async () => {
    const f = fixture();
    const summary = latestEmailResponses()["note/801/analyticsSummary?ajax"];
    f.set({ ...summary, note: { ...summary.note, type: "sms" } });
    expect(await f.read()).toMatchObject({
      selection: "unknown",
      email: null,
      counts: null,
      reason: "unsupported_email_type",
    });
    for (const note of [
      { ...summary.note, ID: "802" },
      { ...summary.note, type: null },
      { ...summary.note, dateTime: "1800000000" },
      { ...summary.note, dateTime: 0 },
    ]) {
      f.set({ ...summary, note });
      await expect(f.read()).rejects.toMatchObject({
        code: "invalid_response",
      });
    }
    f.set({ success: false });
    await expect(f.read()).rejects.toMatchObject({ code: "upstream_rejected" });
    f.set({ ...summary, success: undefined });
    await expect(f.read()).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("rejects invalid selectors before reads and honors cancellation after a read", async () => {
    for (const input of [
      null,
      {},
      { emailId: "../801" },
      { emailId: "801", groupId: "101" },
      { groupId: "101", groupName: "Everyone" },
      { emailId: "801", groupName: "Everyone" },
      { groupName: " " },
      { groupId: "../101" },
      { groupId: "101", userId: "301" },
    ]) {
      expect(() => new EmailAnalytics(input as { emailId: string })).toThrow(
        FlockbotError,
      );
    }
    const f = fixture();
    f.context.check = () => {
      if (f.requests.length) throw new FlockbotError("operation_cancelled");
    };
    await expect(f.read()).rejects.toMatchObject({
      code: "operation_cancelled",
    });
    expect(f.requests).toHaveLength(1);
  });

  it.each([{ groupId: "00101" }, { groupName: " EVERYONE " }])(
    "selects the newest original email with %j, reusing its summary without recipient reads",
    async (input) => {
      const f = fixture();
      const lookup = new EmailAnalytics(input);
      const requested = input.groupId
        ? { groupId: "101" }
        : { groupName: "EVERYONE" };
      input.groupId = "999";
      // A conflicting secondary analytics count must not replace the summary.
      Object.assign(f.data["note/801/analytics2?ajax"], {
        counts: { opened: 999 },
      });
      f.responses["user/301/profile"] = new Error("No member needed");
      f.data["note/801/searchAnalytics?ajax"].results = [];
      const result = await lookup.read(f.context, f.network);
      expect(result).toMatchObject({
        requested,
        groupId: "101",
        email: { id: "801", publishedDate: 1800000000 },
        selection: "selected",
        reason: null,
        counts: { opened: 17, unopened: 9, complaint: 0, total: 31 },
      });
      expect(f.requests).toEqual([
        ...(requested.groupName
          ? ["dashboard", "navigation/groups", "network/getMetadata"]
          : []),
        "group/101/notes?ajax&more",
        "note/801/analyticsSummary?ajax",
        "note/801/analytics2?ajax",
      ]);
      expect(result.limitations.join(" ")).toContain("not an atomic snapshot");
      expect(JSON.stringify(result)).not.toMatch(
        /PRIVATE|Author|Rivera|example.test|noteTargets|summaryCounts/,
      );
      expect(JSON.stringify(lookup)).not.toMatch(/101|EVERYONE/);
    },
  );

  it("preserves every conservative selection reason without counts or older fallback", async () => {
    const original = latestEmailResponses();
    const listing = original["group/101/notes?ajax&more"];
    const cases: [string, unknown, string][] = [
      [
        "group/101/notes?ajax&more",
        { ...listing, notes: [], more: false },
        "selection_unavailable",
      ],
      ...[1800000000, 1900000000].map(
        (publishedDate): [string, unknown, string] => [
          "group/101/notes?ajax&more",
          {
            ...listing,
            notes: [listing.notes[0], { ...listing.notes[1], publishedDate }],
          },
          "selection_ambiguous",
        ],
      ),
      [
        "group/101/notes?ajax&more",
        {
          ...listing,
          notes: [{ ...listing.notes[0], status: "draft" }, listing.notes[1]],
        },
        "selection_ambiguous",
      ],
      [
        "note/801/analyticsSummary?ajax",
        {
          ...original["note/801/analyticsSummary?ajax"],
          note: {
            ...original["note/801/analyticsSummary?ajax"].note,
            type: "sms",
          },
        },
        "unsupported_latest_note",
      ],
      [
        "note/801/analyticsSummary?ajax",
        {
          ...original["note/801/analyticsSummary?ajax"],
          note: {
            ...original["note/801/analyticsSummary?ajax"].note,
            noteTargets: [{ groupID: 999 }],
          },
        },
        "inconsistent_email_metadata",
      ],
      [
        "note/801/analytics2?ajax",
        {
          ...original["note/801/analytics2?ajax"],
          sendingSummary: [{ fromDate: 1800000000 }, { fromDate: 1900000000 }],
        },
        "unsupported_send_history",
      ],
    ];
    for (const [path, response, reason] of cases) {
      const f = fixture();
      f.responses[path] = response;
      expect(await f.read({ groupId: "101" })).toMatchObject({
        selection: "unknown",
        groupId: "101",
        email: null,
        counts: null,
        reason,
      });
      expect(f.requests).toEqual(
        [
          "group/101/notes?ajax&more",
          "note/801/analyticsSummary?ajax",
          "note/801/analytics2?ajax",
        ].slice(
          0,
          path.includes("analytics2") ? 3 : path.includes("Summary") ? 2 : 1,
        ),
      );
    }
  });

  it("keeps group-mode missing counts unknown and rejects invalid counts or failed selection reads", async () => {
    const f = fixture();
    f.set({
      ...f.data["note/801/analyticsSummary?ajax"],
      counts: { opened: 0 },
    });
    expect((await f.read({ groupId: "101" })).counts).toMatchObject({
      opened: 0,
      unopened: null,
    });
    f.set({
      ...f.data["note/801/analyticsSummary?ajax"],
      counts: { opened: -1 },
    });
    await expect(f.read({ groupId: "101" })).rejects.toMatchObject({
      code: "invalid_response",
    });
    f.responses["note/801/analytics2?ajax"] = new FlockbotError(
      "permission_denied",
    );
    await expect(f.read({ groupId: "101" })).rejects.toMatchObject({
      code: "permission_denied",
    });
  });

  it.each([1, 2, 3])(
    "honors cancellation after group request %s without partial success",
    async (limit) => {
      const f = fixture();
      f.context.check = () => {
        if (f.requests.length >= limit)
          throw new FlockbotError("operation_cancelled");
      };
      await expect(f.read({ groupId: "101" })).rejects.toMatchObject({
        code: "operation_cancelled",
      });
      expect(f.requests).toHaveLength(limit);
    },
  );
});
