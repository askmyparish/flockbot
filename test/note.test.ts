import { describe, expect, it, vi } from "vitest";
import { FlockbotError, Note } from "../src/index.js";
import { noteResponse } from "./fixtures/note.js";

function fixture() {
  const data = noteResponse();
  const query = vi.fn(async () => data as unknown);
  const check = vi.fn();
  return {
    data,
    query,
    check,
    read: () =>
      new Note({ noteId: "00801" }).read({
        query,
        check,
        read: async () => {
          throw new Error("Unexpected GET");
        },
      }),
  };
}

describe("JSON note reading", () => {
  it("returns ordered Markdown only, with one existing-note read", async () => {
    const f = fixture();
    const result = await f.read();
    expect(result).toMatchObject({
      noteId: "801",
      title: "Choir plans",
      type: "email",
      status: "published",
      completeness: "complete",
      reason: null,
      omissions: [],
      truncated: false,
    });
    expect(result.markdown).toBe(
      "## Rehearsal\n\nBring **music** and *water*.\n\n- North\n\n- South\n\n> Sing together\n> — Alex\n\n[Details](<https://example.test/choir>)\n\nSee you soon!",
    );
    expect(JSON.stringify(result)).not.toContain("HIDDEN_");
    expect(f.query.mock.calls).toEqual([
      ["composer/editNote", "noteID=801&fromComposer=1"],
    ]);
  });

  it("preserves SMS draft text and line breaks without interpreting Markdown or fetching URLs", async () => {
    const f = fixture();
    f.data.noteInfo.type = "sms";
    f.data.noteInfo.status = "draft";
    f.data.noteInfo.sections = [
      {
        layout: "1",
        col1: {
          items: [
            {
              type: "text",
              data: {
                html: "Alpha & Beta\n*Not emphasis* <tag> https://example.test/sms",
              },
            },
          ],
        },
        col2: { items: [] },
      },
    ];
    expect(await f.read()).toMatchObject({
      completeness: "complete",
      markdown:
        "Alpha & Beta  \n\\*Not emphasis\\* &lt;tag> https://example.test/sms",
    });
  });

  it("preserves prose and hard breaks while escaping authored Markdown syntax", async () => {
    const f = fixture();
    f.data.noteInfo.sections = [
      {
        layout: "1",
        col1: {
          items: [
            {
              type: "text",
              data: {
                html: "<p>alpha@example.test - 1.5 + 2 (yes!) &amp; more<br>Second line</p><p>1. Literal item</p><p># Literal heading</p><p>&gt; Literal quote</p><p>[not a link](https://example.test) &amp;copy; &lt;b&gt;</p><div>With <strong> bold </strong>and <em></em>plain text.</div>",
              },
            },
          ],
        },
        col2: { items: [] },
      },
    ];
    expect((await f.read()).markdown).toBe(
      "alpha@example.test - 1.5 + 2 (yes!) & more  \nSecond line\n\n1\\. Literal item\n\n\\# Literal heading\n\n\\> Literal quote\n\n\\[not a link\\](https://example.test) &amp;copy; &lt;b>\n\nWith  **bold** and plain text.",
    );
  });

  it.each([
    ["email", "<p><br></p>", ""],
    ["email", "<p>Text<br></p><ul><li>a<br></li></ul>", "Text\n\n- a"],
    ["email", "<p><strong>Bold<br></strong>next</p>", "**Bold**  \nnext"],
    ["email", "<p><b><br>x</b></p>", "**x**"],
    ["email", "<p>Authored \\<br>next<br></p>", "Authored \\\\  \nnext"],
    [
      "email",
      "<p>~~~js<br>literal code<br>~~~</p>",
      "\\~~~js  \nliteral code  \n\\~~~",
    ],
    ["sms", "First\r\nLast\n", "First  \nLast  \n"],
  ])(
    "keeps %s hard breaks safe at block edges: %s",
    async (type, html, markdown) => {
      const f = fixture();
      f.data.noteInfo.type = type;
      f.data.noteInfo.sections = [
        {
          layout: "1",
          col1: { items: [{ type: "text", data: { html } }] },
          col2: { items: [] },
        },
      ];
      expect(await f.read()).toMatchObject({
        markdown,
        completeness: "complete",
      });
    },
  );

  it.each([
    [{ status: "deleted" }, "deleted"],
    [{ status: "scheduled" }, "unsupported_status"],
    [{ status: null }, "unsupported_status"],
    [{ type: "push" }, "unsupported_type"],
    [{ newNote: true }, "ambiguous_identity"],
    [{ duplicate: true }, "ambiguous_identity"],
    [{ newNote: undefined }, "ambiguous_identity"],
    [{ autosaveID: 802 }, "ambiguous_identity"],
  ])("withholds all content for %j", async (change, reason) => {
    const f = fixture();
    Object.assign(f.data.noteInfo, change);
    expect(await f.read()).toMatchObject({
      completeness: "unavailable",
      reason,
      title: null,
      markdown: null,
    });
  });

  it.each([
    [{ success: false }, "upstream_rejected", "success_false"],
    [{ success: "true" }, "invalid_response", "expected_success"],
    [{ noteInfo: null }, "invalid_response", "expected_object"],
    [{ noteInfo: { ID: 802 } }, "invalid_response", "note_identity_mismatch"],
  ])(
    "rejects malformed envelopes rather than presenting an empty note: %j",
    async (change, code, reason) => {
      const f = fixture();
      Object.assign(f.data, change);
      await expect(f.read()).rejects.toMatchObject({ code, reason });
    },
  );

  it("retains supported content and reports unknown modules and a second column as partial", async () => {
    const f = fixture();
    f.data.noteInfo.sections[0]!.col1.items.push({
      type: "donation",
      data: { html: "HIDDEN_UNSUPPORTED" },
    });
    f.data.noteInfo.sections[0]!.col2.items.push({
      type: "text",
      data: { html: "<p>Right column</p>" },
    } as never);
    const r = await f.read();
    expect(r.completeness).toBe("partial");
    expect(r.omissions).toEqual(["unsupported_module", "unsupported_layout"]);
    expect(r.markdown).toContain(
      "Details](<https://example.test/choir>)\n\nRight column\n\nSee you soon",
    );
    expect(r.markdown).not.toContain("HIDDEN");
  });

  it("distinguishes established empty content from absent or malformed content", async () => {
    const f = fixture();
    f.data.noteInfo.sections = [];
    expect(await f.read()).toMatchObject({
      markdown: "",
      completeness: "complete",
    });
    for (const sections of [
      undefined,
      {},
      [null],
      [{ layout: "1", col1: { items: [null] }, col2: { items: [] } }],
    ]) {
      Object.assign(f.data.noteInfo, { sections });
      expect(await f.read()).toMatchObject({
        markdown: "",
        completeness: "partial",
        omissions: ["invalid_content"],
      });
    }
  });

  it("drops scripts, controls, hidden content and unsafe links without losing safe labels", async () => {
    const f = fixture();
    f.data.noteInfo.sections = [
      {
        layout: "1",
        col1: {
          items: [
            {
              type: "text",
              data: {
                html: '<script>HIDDEN_SCRIPT</script><input value="HIDDEN_TOKEN"><p hidden>HIDDEN_TEXT</p><div style="display:none">HIDDEN_CSS</div><img src="https://example.test/tracker"><a href="javascript:alert(1)">Unsafe</a> <a href="https://user:password@example.test">Credentials</a> <a href="https://example.test/a(b)?x=1&amp;y=2">Safe</a> &lt;script&gt;not code&lt;/script&gt;',
              },
            },
          ],
        },
        col2: { items: [] },
      },
    ];
    const r = await f.read();
    expect(r).toMatchObject({
      completeness: "partial",
      omissions: ["unsupported_markup", "unsafe_link"],
    });
    expect(r.markdown).toContain(
      "Unsafe Credentials [Safe](<https://example.test/a%28b%29?x=1&y=2>)",
    );
    expect(r.markdown).toContain("&lt;script>not code&lt;/script>");
    expect(r.markdown).not.toMatch(
      /HIDDEN|password|javascript:|<script>|tracker/,
    );
  });

  it("bounds output and title independently, and reports input/module/section caps", async () => {
    const f = fixture();
    const section = (html: string) => ({
      layout: "1",
      col1: { items: [{ type: "text", data: { html } }] },
      col2: { items: [] },
    });
    f.data.noteInfo.title = "a".repeat(512);
    f.data.noteInfo.sections = [section("x".repeat(32000))];
    expect(await f.read()).toMatchObject({
      titleTruncated: false,
      completeness: "complete",
      truncated: false,
      markdown: "x".repeat(32000),
    });
    f.data.noteInfo.title = "a".repeat(513);
    expect(await f.read()).toMatchObject({
      titleTruncated: true,
      completeness: "partial",
      omissions: ["limit"],
      truncated: true,
      markdown: "x".repeat(32000),
    });
    f.data.noteInfo.title = "Title";
    f.data.noteInfo.sections = [section("x".repeat(32001))];
    expect(await f.read()).toMatchObject({
      completeness: "partial",
      omissions: ["limit"],
      markdown: "x".repeat(32000),
    });
    f.data.noteInfo.sections = [section("x".repeat(256 * 1024 + 1))];
    expect(await f.read()).toMatchObject({
      completeness: "partial",
      omissions: ["limit"],
      markdown: "",
    });
    f.data.noteInfo.sections = Array.from({ length: 101 }, () => section("x"));
    expect((await f.read()).omissions).toEqual(["limit"]);
    f.data.noteInfo.sections = [section("x")];
    f.data.noteInfo.sections[0]!.col1.items = Array.from(
      { length: 101 },
      (_, i) => ({ type: "text", data: { html: String(i) } }),
    );
    const r = await f.read();
    expect(r).toMatchObject({
      completeness: "partial",
      truncated: true,
      omissions: ["limit"],
    });
    expect(r.markdown?.split("\n\n")).toHaveLength(100);
    expect(r.markdown).toMatch(/\n\n99$/);
  });

  it("validates before requests and observes cancellation after a response", async () => {
    for (const input of [
      { noteId: "../note" },
      { noteId: "" },
      { noteId: "a".repeat(129) },
      { noteId: 801 },
      { noteId: "801", save: true },
    ]) {
      expect(() => new Note(input as never)).toThrow(FlockbotError);
    }
    const f = fixture();
    f.check
      .mockImplementationOnce(() => {})
      .mockImplementation(() => {
        throw new FlockbotError("operation_cancelled");
      });
    await expect(f.read()).rejects.toMatchObject({
      code: "operation_cancelled",
    });
    expect(f.query).toHaveBeenCalledTimes(1);
  });
});
