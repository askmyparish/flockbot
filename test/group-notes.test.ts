import { describe, expect, it } from "vitest";
import { FlockbotError, GroupNotes, Network } from "../src/index.js";
import { latestEmailResponses } from "./fixtures/latest-email.js";

function fixture() {
  const data: { groupID: unknown; more: unknown; notes: unknown } =
    latestEmailResponses()["group/101/notes?ajax&more"];
  const paths: string[] = [];
  let cancelled = false;
  const context = {
    read: async (path: string) => {
      paths.push(path);
      return data;
    },
    check: () => {
      if (cancelled) throw new FlockbotError("operation_cancelled");
    },
  };
  return {
    data,
    paths,
    context,
    cancel: () => {
      cancelled = true;
    },
    read: () =>
      new GroupNotes({ groupId: "00101" }).list(
        context,
        new Network("example-parish"),
      ),
  };
}

describe("bounded group note discovery", () => {
  it("preserves mixed publication states and upstream order without inferring channel or exposing other fields", async () => {
    const f = fixture();
    // Non-published statuses simulate parser policy, not observed listing values.
    f.data.notes = [
      {
        ID: 802,
        title: " Choir plans ",
        publishedDate: 1700000000,
        status: "scheduled",
        summary: "HIDDEN_BODY",
        fname: "HIDDEN_AUTHOR",
        previewURL: "HIDDEN_URL",
      },
      {
        ID: "00801",
        title: "Fundraiser",
        publishedDate: 1800000000,
        status: "published",
        type: "email",
        token: "HIDDEN_TOKEN",
      },
      { ID: 800, title: null, publishedDate: 0, status: "draft" },
      { ID: 799, title: 4, publishedDate: "1800000000", status: "unsupported" },
    ];
    const result = await f.read();
    expect(result).toMatchObject({
      requested: { groupId: "101" },
      groupId: "101",
      returnedCount: 4,
      upstreamReturnedCount: 4,
      hasMore: true,
      truncated: false,
    });
    expect(result.notes).toEqual([
      {
        id: "802",
        title: "Choir plans",
        publishedDate: 1700000000,
        status: "scheduled",
        type: null,
        titleTruncated: false,
      },
      {
        id: "801",
        title: "Fundraiser",
        publishedDate: 1800000000,
        status: "published",
        type: null,
        titleTruncated: false,
      },
      {
        id: "800",
        title: null,
        publishedDate: null,
        status: "draft",
        type: null,
        titleTruncated: false,
      },
      {
        id: "799",
        title: null,
        publishedDate: null,
        status: null,
        type: null,
        titleTruncated: false,
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("HIDDEN_");
    expect(f.paths).toEqual(["group/101/notes?ajax&more"]);
    expect(Number.isNaN(Date.parse(result.observedAt))).toBe(false);
  });

  it("distinguishes server continuation from local row and title clipping at the boundaries", async () => {
    const f = fixture();
    const rows = Array.from({ length: 50 }, (_, i) => ({
      ID: i + 1,
      title: "t".repeat(512),
    }));
    f.data.notes = rows;
    f.data.more = true;
    expect(await f.read()).toMatchObject({
      returnedCount: 50,
      upstreamReturnedCount: 50,
      hasMore: true,
      truncated: false,
    });
    rows.push({ ID: 51, title: "Not emitted" });
    f.data.more = false;
    expect(await f.read()).toMatchObject({
      returnedCount: 50,
      upstreamReturnedCount: 51,
      hasMore: false,
      truncated: true,
    });
    f.data.notes = [{ ID: 1, title: "x".repeat(513) }];
    expect(await f.read()).toMatchObject({
      truncated: true,
      notes: [{ title: "x".repeat(512), titleTruncated: true }],
    });
    f.data.notes = [];
    expect(await f.read()).toMatchObject({
      notes: [],
      returnedCount: 0,
      hasMore: false,
      truncated: false,
    });
    f.data.more = true;
    expect(await f.read()).toMatchObject({ notes: [], hasMore: true });
  });

  it("rejects invalid identities beyond the cap and malformed envelopes with fixed reasons", async () => {
    for (const [change, reason] of [
      [{ groupID: 999 }, "group_identity_mismatch"],
      [{ notes: null }, "expected_notes_array"],
      [{ more: "false" }, "expected_pagination_boolean"],
      [{ notes: [{ ID: 1 }, { ID: "001" }] }, "duplicate_identifier"],
      [{ notes: [{ ID: "x".repeat(129) }] }, "identifier_too_long"],
    ] as const) {
      const f = fixture();
      Object.assign(f.data, change);
      await expect(f.read()).rejects.toMatchObject({
        code: "invalid_response",
        reason,
      });
    }
    for (const last of [{ ID: "001" }, { ID: "../52" }]) {
      const f = fixture();
      f.data.notes = [
        ...Array.from({ length: 50 }, (_, i) => ({ ID: i + 1 })),
        last,
      ];
      await expect(f.read()).rejects.toMatchObject({
        code: "invalid_response",
      });
    }
  });

  it("rejects selectors before reads and honors cancellation before and after I/O", async () => {
    for (const input of [
      {},
      { groupId: "101", groupName: "Everyone" },
      { groupName: " " },
      { groupId: "../101" },
      { groupId: "101", limit: 500 },
    ])
      expect(() => new GroupNotes(input)).toThrow(FlockbotError);
    const before = fixture();
    before.cancel();
    await expect(before.read()).rejects.toMatchObject({
      code: "operation_cancelled",
    });
    expect(before.paths).toEqual([]);
    const after = fixture();
    after.context.read = async (path) => {
      after.paths.push(path);
      after.cancel();
      return after.data;
    };
    await expect(after.read()).rejects.toMatchObject({
      code: "operation_cancelled",
    });
    expect(after.paths).toEqual(["group/101/notes?ajax&more"]);
  });
});
