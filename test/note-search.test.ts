import { describe, expect, it } from "vitest";
import { FlockbotError, NoteSearch } from "../src/index.js";
import { noteSearchResponse } from "./fixtures/note-search.js";

function fixture() {
  const state: {
    metadata: unknown;
    response: unknown;
    cancelAfter: string | undefined;
  } = {
    metadata: { success: true, networkID: 201 },
    response: noteSearchResponse(),
    cancelAfter: undefined,
  };
  const requests: { path: string; body?: string }[] = [];
  let cancelled = false;
  const context = {
    read: async () => {
      throw new Error("Unexpected GET");
    },
    query: async (path: string, body?: string) => {
      requests.push({ path, ...(body === undefined ? {} : { body }) });
      cancelled = state.cancelAfter === path;
      return path === "network/getMetadata" ? state.metadata : state.response;
    },
    check: () => {
      if (cancelled) throw new FlockbotError("operation_cancelled");
    },
  };
  return {
    state,
    requests,
    run: () => new NoteSearch({ searchTerm: " choir + plans " }).find(context),
  };
}

describe("bounded parish note search", () => {
  it("requests only notes and omits unexpected non-note results without private payloads", async () => {
    const f = fixture();
    const result = await f.run();
    expect(f.requests).toEqual([
      { path: "network/getMetadata" },
      {
        path: "supersearch/query?ajax",
        body: "searchTerm=choir+%2B+plans&networkID=201&filters%5B%5D=note",
      },
    ]);
    expect(result).toMatchObject({
      totalHits: 12,
      upstreamReturnedCount: 4,
      returnedCount: 3,
      omittedNonNoteCount: 1,
      clippedNoteCount: 0,
      completeness: "partial",
      truncated: false,
    });
    expect(result.notes).toEqual([
      {
        id: "803",
        title: "Choir plans",
        titleTruncated: false,
        date: 1800000000,
        type: "scheduled",
        groupTargets: [
          { groupId: "101", name: "Everyone", nameTruncated: false },
        ],
        groupTargetsTruncated: false,
      },
      {
        id: "801",
        title: "Rehearsal",
        titleTruncated: false,
        date: 1700000000,
        type: "email",
        groupTargets: null,
        groupTargetsTruncated: false,
      },
      {
        id: "802",
        title: "Reminder",
        titleTruncated: false,
        date: 1750000000,
        type: "sms",
        groupTargets: null,
        groupTargetsTruncated: false,
      },
    ]);
    expect(JSON.stringify(result)).not.toMatch(
      /HIDDEN_|searchFilters|networkID|author|plainText|previewURL/,
    );
  });

  it("preserves unknown optional evidence and never promotes entity IDs to group IDs", async () => {
    const f = fixture();
    const response = noteSearchResponse();
    response.searchResults = [
      {
        entityType: "note",
        noteID: 1,
        type: "future",
        noteTitle: 7,
        date: "yesterday",
        noteTargets: [
          { type: "group", entityID: 909, name: "HIDDEN_UNPROVEN" },
        ],
      },
      {
        entityType: "note",
        noteID: 2,
        noteTargets: [
          { type: "group", groupID: "../private", name: "HIDDEN_INVALID" },
        ],
      },
      { entityType: "future-entity", noteID: 3, plainText: "HIDDEN_ENTITY" },
    ] as unknown as typeof response.searchResults;
    f.state.response = response;
    const result = await f.run();
    expect(result.notes).toMatchObject([
      { id: "1", type: null, title: null, date: null, groupTargets: [] },
      { id: "2", groupTargets: null },
    ]);
    expect(result.omittedNonNoteCount).toBe(1);
    expect(JSON.stringify(result)).not.toContain("HIDDEN_");
  });

  it("separates upstream incompleteness, empty results and local clipping", async () => {
    const f = fixture();
    const base = noteSearchResponse();
    f.state.response = { ...base, totalHits: 0, searchResults: [] };
    expect(await f.run()).toMatchObject({
      returnedCount: 0,
      completeness: "unknown",
      truncated: false,
    });
    const rows = Array.from({ length: 50 }, (_, i) => ({
      entityType: "note",
      noteID: i + 1,
      noteTitle: "t".repeat(512),
    }));
    f.state.response = { ...base, totalHits: 50, searchResults: rows };
    expect(await f.run()).toMatchObject({
      returnedCount: 50,
      clippedNoteCount: 0,
      completeness: "unknown",
      truncated: false,
    });
    rows.push({ entityType: "note", noteID: 51, noteTitle: "Extra" });
    f.state.response = {
      ...base,
      totalHits: 52,
      searchResults: [...rows, { entityType: "group" }],
    };
    expect(await f.run()).toMatchObject({
      returnedCount: 50,
      upstreamReturnedCount: 52,
      omittedNonNoteCount: 1,
      clippedNoteCount: 1,
      completeness: "partial",
      truncated: true,
    });
    f.state.response = {
      ...base,
      totalHits: 1,
      searchResults: [
        {
          entityType: "note",
          noteID: 1,
          noteTitle: "t".repeat(513),
          noteTargets: Array.from({ length: 11 }, (_, i) => ({
            type: "group",
            groupID: i + 1,
            name: "n".repeat(i === 0 ? 257 : 256),
          })),
        },
      ],
    };
    const clipped = await f.run();
    expect(clipped).toMatchObject({
      truncated: true,
      clippedNoteCount: 0,
      notes: [
        {
          title: "t".repeat(512),
          titleTruncated: true,
          groupTargetsTruncated: true,
        },
      ],
    });
    expect(clipped.notes[0]?.groupTargets).toHaveLength(10);
    expect(clipped.notes[0]?.groupTargets?.[0]).toEqual({
      groupId: "1",
      name: "n".repeat(256),
      nameTruncated: true,
    });
    expect(clipped.notes[0]?.groupTargets?.[1]?.nameTruncated).toBe(false);
    for (const [count, nameLength, targetsTruncated, nameTruncated] of [
      [10, 256, false, false],
      [10, 257, false, true],
      [11, 256, true, false],
    ] as const) {
      f.state.response = {
        ...base,
        totalHits: 1,
        searchResults: [
          {
            entityType: "note",
            noteID: 1,
            noteTargets: Array.from({ length: count }, (_, i) => ({
              type: "group",
              groupID: i + 1,
              name: "n".repeat(nameLength),
            })),
          },
        ],
      };
      const result = await f.run();
      expect(result.truncated).toBe(targetsTruncated || nameTruncated);
      expect(result.notes[0]?.groupTargetsTruncated).toBe(targetsTruncated);
      expect(result.notes[0]?.groupTargets).toHaveLength(10);
      expect(result.notes[0]?.groupTargets?.[0]?.nameTruncated).toBe(
        nameTruncated,
      );
    }
  });

  it("rejects bad metadata before searching and contradictory search envelopes instead of returning no matches", async () => {
    for (const metadata of [
      { success: false },
      { networkID: 201 },
      { success: true, networkID: 0 },
    ]) {
      const f = fixture();
      f.state.metadata = metadata;
      await expect(f.run()).rejects.toBeInstanceOf(FlockbotError);
      expect(f.requests).toEqual([{ path: "network/getMetadata" }]);
    }
    for (const change of [
      { success: false },
      { success: undefined },
      { searchTerm: "another term" },
      { searchFilters: [] },
      {
        searchFilters: {
          ...noteSearchResponse().searchFilters,
          note: false,
        },
      },
      {
        searchFilters: {
          ...noteSearchResponse().searchFilters,
          userDocument: 1,
        },
      },
      { totalHits: 3 },
      { totalHits: 4.5 },
      { searchResults: null },
    ]) {
      const f = fixture();
      f.state.response = { ...noteSearchResponse(), ...change };
      await expect(f.run()).rejects.toBeInstanceOf(FlockbotError);
      expect(f.requests).toHaveLength(2);
    }
  });

  it.each(["event", "file", "user", "group", "comment", "userDocument"])(
    "rejects an enabled, missing or malformed %s filter instead of accepting a broader search",
    async (filter) => {
      for (const value of [true, undefined, "false"]) {
        const f = fixture();
        const response = noteSearchResponse();
        f.state.response = {
          ...response,
          searchFilters: { ...response.searchFilters, [filter]: value },
        };
        await expect(f.run()).rejects.toMatchObject({
          code: "invalid_response",
          reason: "search_filter_shape",
        });
        expect(f.requests).toHaveLength(2);
      }
    },
  );

  it("validates every note identity including beyond the cap", async () => {
    const base = noteSearchResponse();
    for (const [row, reason] of [
      [{ noteID: 51, entityID: 52 }, "note_identity_mismatch"],
      [{ noteID: "../bad" }, "expected_identifier"],
      [{}, "expected_text"],
      [{ noteID: "x".repeat(129) }, "identifier_too_long"],
      [{ noteID: "00050" }, "duplicate_identifier"],
    ] as const) {
      const f = fixture();
      f.state.response = {
        ...base,
        totalHits: 51,
        searchResults: [
          ...Array.from({ length: 50 }, (_, i) => ({
            entityType: "note",
            noteID: i + 1,
          })),
          { entityType: "note", ...row },
        ],
      };
      await expect(f.run()).rejects.toMatchObject({
        code: "invalid_response",
        reason,
      });
    }
  });

  it("validates input before execution and honors cancellation between resource reads", async () => {
    for (const input of [
      { searchTerm: " " },
      { searchTerm: "x".repeat(257) },
      { searchTerm: "a\nb" },
      { searchTerm: "choir", groupId: "101" },
    ])
      expect(() => new NoteSearch(input)).toThrow(FlockbotError);
    for (const path of ["network/getMetadata", "supersearch/query?ajax"]) {
      const f = fixture();
      f.state.cancelAfter = path;
      await expect(f.run()).rejects.toMatchObject({
        code: "operation_cancelled",
      });
      expect(f.requests).toHaveLength(path === "network/getMetadata" ? 1 : 2);
    }
  });
});
