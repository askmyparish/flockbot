import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EmailDraft,
  FlockbotError,
  Network,
  type EmailDraftInput,
} from "../../src/index.js";
import { BrowserConnection } from "../../adapters/mcp/src/browser-connection.js";
import type { DraftImage } from "../../adapters/mcp/src/draft-images.js";
import { SerialCoordinator } from "../../adapters/mcp/src/serial-coordinator.js";
import {
  failureDiagnostic,
  recordResponse,
  runDiagnostic,
} from "../../adapters/mcp/src/diagnostics.js";
import {
  draftInput,
  draftResponse,
  draftReadback,
  draftHtml,
  draftInitialization,
  htmlDraftInput,
  htmlDraftStored,
  blockDraftInput,
  blockDraftStored,
  blockDraftResponse,
  imageDraftInput,
  imageDraftResponse,
} from "../fixtures/email-draft.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
function fixture(
  change?: (
    path: string,
    body: string | undefined,
    response: unknown,
    count: number,
    photo?: DraftImage,
  ) => unknown,
) {
  const requests: {
    path: string;
    method: string;
    body?: string | undefined;
  }[] = [];
  const request = async (
    path: string,
    method = "GET",
    body?: string,
    photo?: DraftImage,
  ) => {
    requests.push({ path, method, body });
    const response = draftResponse(path, body);
    return change
      ? change(path, body, response, requests.length, photo)
      : response;
  };
  const profile = mkdtempSync(join(tmpdir(), "flockbot-draft-"));
  writeFileSync(
    join(profile, "connection.json"),
    JSON.stringify({
      version: 1,
      generation: "00000000-0000-4000-8000-000000000001",
      parish: "example-parish",
      userId: "201",
      state: "ready",
    }),
    { mode: 0o600 },
  );
  const connection = new BrowserConnection({
    profile,
    coordinator: new SerialCoordinator(),
    factory: async () => ({
      request,
      signIn: async () => {},
      close: async () => {},
    }),
  });
  cleanup.push(async () => {
    await connection.close();
    rmSync(profile, { recursive: true, force: true });
  });
  return {
    connection,
    requests,
    context: {
      check() {},
      read: (p: string) => request(p),
      query: (p: string, b?: string) => request(p, "POST", b),
      compose: (p: string, b: string) => request(p, "POST", b),
    },
  };
}
const sequence = [
  "dashboard",
  "network/getMetadata",
  "network/501/writeNewNote?ajax",
  "composer/createNote",
  "composer/save2",
  "composer/saveModule",
  "composer/saveSection",
  "composer/saveLayout",
  "composer/save2",
  "composer/save2",
  "composer/editNote",
];

describe("create-only email drafts", () => {
  it.each([false, true])(
    "preserves ordered blocks and isolates caller mutations (buttons only: %s)",
    async (buttonsOnly) => {
      const input = structuredClone(blockDraftInput);
      const items = buttonsOnly
        ? blockDraftStored.filter((x) => x.type === "button")
        : blockDraftStored;
      if (buttonsOnly)
        input.content = input.content.filter((x) => x.type === "button");
      const response = blockDraftResponse(items);
      const f = fixture((path, body) => response(path, body));
      const draft = new EmailDraft(input);
      input.content.length = 0;
      const snapshot = draft.toInput();
      (snapshot.content as unknown[]).length = 0;
      expect(
        await draft.create(f.context, new Network("example-parish")),
      ).toMatchObject({
        verified: true,
        noteId: "803",
      });
      const modules = f.requests
        .filter((r) => r.path === "composer/saveModule")
        .map((r) => new URLSearchParams(r.body));
      expect(modules.map((m) => m.get("type"))).toEqual(
        buttonsOnly
          ? ["button", "button"]
          : ["text", "button", "text", "button"],
      );
      const buttons = modules.filter((m) => m.get("type") === "button");
      expect(
        buttons.map((m) => [m.get("data[text]"), m.get("data[url]")]),
      ).toEqual([
        [
          `Join <b> & "quoted" O'Neil café 🕊 &lt;`,
          "https://example.test/register?a=1&b=2#part",
        ],
        ["More information", "http://example.test/info"],
      ]);
      expect(buttons[0]?.get("data[backgroundColor]")).toBe("336699");
      const layout = new URLSearchParams(
        f.requests.find((r) => r.path === "composer/saveLayout")?.body,
      );
      expect(layout.getAll("sections[0][modules][]")).toEqual(
        buttonsOnly ? ["812", "814"] : ["811", "812", "813", "814"],
      );
      expect(
        draft.progress.completedStages.filter((s) => s === "module"),
      ).toHaveLength(1);
      expect(JSON.stringify(draft)).not.toContain("Join");
    },
  );

  it.each([
    {},
    { content: [] },
    { content: [null] },
    { content: new Array(1) },
    { body: "text", content: blockDraftInput.content },
    { bodyFormat: "text", content: blockDraftInput.content },
    { content: [{ type: "video", url: "https://example.test" }] },
    { content: [{ type: "text", body: " " }] },
    { content: [{ type: "text", body: "a\u0085b" }] },
    { content: [{ type: "text", body: "a\ud800b" }] },
    { content: [{ type: "text", body: "x", bodyFormat: "markdown" }] },
    { content: [{ type: "button", text: " ", url: "https://example.test" }] },
    {
      content: [
        { type: "button", text: "a\udfffb", url: "https://example.test" },
      ],
    },
    {
      content: [
        { type: "button", text: "\u200b", url: "https://example.test" },
      ],
    },
    {
      content: [
        { type: "button", text: "line\nbreak", url: "https://example.test" },
      ],
    },
    {
      content: [
        {
          type: "button",
          text: "Label",
          url: "https://example.test",
          style: "red",
        },
      ],
    },
    ...[
      "javascript:alert(1)",
      "//example.test",
      "/relative",
      "mailto:a@example.test",
      "https://user:pass@example.test",
      "https://example.test/\nx",
      "https://example.test\\@other.test",
      "https://example.test/\ud800",
    ].map((url) => ({ content: [{ type: "button", text: "Label", url }] })),
  ])("rejects malformed ordered input before I/O: %j", async (payload) => {
    const f = fixture();
    await expect(
      f.connection.createEmailDraft({
        groupName: "Choir",
        subject: "Test",
        ...payload,
      } as EmailDraftInput),
    ).rejects.toMatchObject({
      code: "invalid_input",
      outcome: "not_submitted",
    });
    expect(f.requests).toEqual([]);
  });

  it.each([
    "label",
    "url",
    "style",
    "extra-style",
    "type",
    "id",
    "missing",
    "extra",
    "order",
  ])("fails closed on persisted block changes: %s", async (change) => {
    const stored = structuredClone(blockDraftStored);
    const button = stored[1]!;
    if (change === "label") button.data.text = "Changed";
    if (change === "url") button.data.url = "https://example.test/other";
    if (change === "style") button.data.backgroundColor = "000000";
    if (change === "extra-style")
      Object.assign(button.data, { base64Gradient: "changed" });
    if (change === "type") button.type = "text";
    if (change === "id") button.data.ID = 999;
    if (change === "missing") stored.pop();
    if (change === "extra") stored.push(stored[0]!);
    if (change === "order") stored.reverse();
    const wire = blockDraftResponse(),
      readback = blockDraftResponse(stored);
    const f = fixture((p, b) =>
      p === "composer/editNote" ? readback(p, b) : wire(p, b),
    );
    await expect(
      f.connection.createEmailDraft(blockDraftInput),
    ).rejects.toMatchObject({
      reason: "draft_verification",
      outcome: "unknown",
      draftProgress: { stage: "verify", noteId: "803", autosaveId: "801" },
    });
    expect(
      f.requests.filter((r) => r.path === "composer/saveModule"),
    ).toHaveLength(4);
    expect(f.requests.at(-1)?.path).toBe("composer/editNote");
  });

  it.each(["duplicate", "malformed", "transport"])(
    "stops after a later module fails without replay: %s",
    async (kind) => {
      let count = 0;
      const response = blockDraftResponse();
      const f = fixture((p, b) => {
        if (p === "composer/saveModule" && ++count === 2) {
          if (kind === "transport") throw new FlockbotError("transport_failed");
          return {
            success: true,
            itemID: kind === "duplicate" ? "811" : "bad",
          };
        }
        return response(p, b);
      });
      await expect(
        f.connection.createEmailDraft(blockDraftInput),
      ).rejects.toMatchObject({
        outcome: "unknown",
        draftProgress: {
          stage: "module",
          autosaveId: "801",
          completedStages: ["resolve_group", "entry", "initialize", "autosave"],
        },
        ...(kind === "duplicate"
          ? { reason: "duplicate_identifier" }
          : kind === "malformed"
            ? { reason: "expected_identifier" }
            : { code: "transport_failed" }),
      });
      expect(count).toBe(2);
      expect(f.requests.at(-1)?.path).toBe("composer/saveModule");
    },
  );

  it("preserves supported HTML structure, entities and links through the shared writer", async () => {
    const f = fixture((path, _body, response) =>
      path === "composer/editNote"
        ? draftResponse(path, undefined, htmlDraftStored)
        : response,
    );
    expect(await f.connection.createEmailDraft(htmlDraftInput)).toMatchObject({
      verified: true,
      status: "draft",
      noteId: "803",
    });
    expect(f.requests.map((r) => r.path)).toEqual(sequence);
    const wire = new URLSearchParams(
      f.requests.find((r) => r.path === "composer/saveModule")!.body,
    ).get("data[html]");
    expect(wire).toBe(
      '<h1>One</h1><h2>Two</h2><h3>Three</h3><h4>Four</h4><h5>Five</h5><h6>Six</h6> <div><p>A <strong>bold</strong> <b>alias</b> <em>emphasis</em> <i>italic</i><br>Literal &amp;#60;b&amp;#62; &amp;#38;lt; &amp;#34; &amp;#39; café 🕊</p><ul><li>First</li><li><ol><li>Nested</li></ol></li></ul><blockquote><p>Quote</p></blockquote><a href="https://example.test/?a=1&amp;#38;b=2#part">A &amp;#38; B</a></div>',
    );
  });

  it.each([
    ["<p>unclosed", "draft_html_malformed"],
    ["<p>one<p>two</p>", "draft_html_malformed"],
    ["<strong><em>x</strong></em>", "draft_html_malformed"],
    ["<!doctype html><p>x</p>", "draft_html_malformed"],
    ["<html><body><p>x</p></body></html>", "draft_html_malformed"],
    ["<div>x</div></span>", "draft_html_malformed"],
    [
      '<a href="https://example.test" href="https://other.test">x</a>',
      "draft_html_malformed",
    ],
    ["<script>x</script>", "draft_html_unsupported"],
    ['<div style="color:red">x</div>', "draft_html_unsupported"],
    ['<p onclick="x">x</p>', "draft_html_unsupported"],
    ['<div class="x">x</div>', "draft_html_unsupported"],
    ['<img src="https://example.test/x">', "draft_html_unsupported"],
    ["<table><tr><td>x</td></tr></table>", "draft_html_unsupported"],
    ["<svg><text>x</text></svg>", "draft_html_unsupported"],
    ["<template><p>x</p></template>", "draft_html_unsupported"],
    ["<!--hidden--><p>x</p>", "draft_html_unsupported"],
    ["<li>orphan</li>", "draft_html_unsupported"],
    ["<ul>unwrapped text<li>item</li></ul>", "draft_html_unsupported"],
    ["<ol><div>not an item</div></ol>", "draft_html_unsupported"],
    ["<b><p>block</p></b>", "draft_html_unsupported"],
    [
      '<strong><a href="https://example.test"><div>block</div></a></strong>',
      "draft_html_unsupported",
    ],
    ["<a>x</a>", "draft_html_unsupported"],
    ['<a href="javascript:alert(1)">x</a>', "draft_html_unsafe_link"],
    ['<a href="java&#115;cript:alert(1)">x</a>', "draft_html_unsafe_link"],
    ['<a href="//example.test">x</a>', "draft_html_unsafe_link"],
    ['<a href="/relative">x</a>', "draft_html_unsafe_link"],
    ['<a href="mailto:a@example.test">x</a>', "draft_html_unsafe_link"],
    [
      '<a href="https://user:password@example.test">x</a>',
      "draft_html_unsafe_link",
    ],
    ['<a href="https://example.test/&#10;x">x</a>', "draft_html_unsafe_link"],
    [
      '<a href="https://example.test\\@other.test">x</a>',
      "draft_html_unsafe_link",
    ],
    ["<p> &nbsp; <br></p>", "draft_html_empty"],
    ["<p>&#8203;</p>", "draft_html_empty"],
  ])(
    "rejects unsafe or unsupported fragments before I/O: %s",
    async (body, reason) => {
      const f = fixture();
      await expect(
        f.connection.createEmailDraft({ ...htmlDraftInput, body }),
      ).rejects.toMatchObject({
        code: "invalid_input",
        outcome: "not_submitted",
        reason,
      });
      expect(f.requests).toEqual([]);
    },
  );

  it.each([
    htmlDraftStored.replace("<strong>bold</strong>", "bold"),
    htmlDraftStored.replace("<h1>One</h1>", "<h2>One</h2>"),
    htmlDraftStored.replace("b=2", "b=3"),
    htmlDraftStored.replace("&#60;b&#62;", "<b>changed</b>"),
    htmlDraftStored.replace(
      "<div>Quote</div>",
      '<div style="color:red">Quote</div>',
    ),
    htmlDraftStored + "<script>unexpected</script>",
    htmlDraftStored.replace("<ul>", "<ul><li>Inserted</li>"),
    htmlDraftStored.replace("A <strong>", "A<strong>"),
  ])(
    "reports unknown progress for altered persisted markup",
    async (stored) => {
      const f = fixture((path, _body, response) =>
        path === "composer/editNote"
          ? draftResponse(path, undefined, stored)
          : response,
      );
      await expect(
        f.connection.createEmailDraft(htmlDraftInput),
      ).rejects.toMatchObject({
        code: "invalid_response",
        reason: "draft_verification",
        outcome: "unknown",
        draftProgress: { stage: "verify", noteId: "803", autosaveId: "801" },
      });
      expect(f.requests.map((r) => r.path)).toEqual(sequence);
    },
  );

  it("accepts equivalent HTML syntax without changing text or link destinations", async () => {
    const body =
      '<P>A &amp; B <A HREF="http://example.test/path?q=&quot;x&quot;">link</A></P>';
    const stored =
      '<div>A &#38; B <a href="http://example.test/path?q=&#34;x&#34;">link</a></div>';
    const f = fixture((path, _body, response) =>
      path === "composer/editNote"
        ? draftResponse(path, undefined, stored)
        : response,
    );
    expect(
      await f.connection.createEmailDraft({ ...htmlDraftInput, body }),
    ).toMatchObject({ verified: true });
  });

  it("preserves indented content and empty blocks while removing only outer HTML whitespace", async () => {
    const body =
      "\n  <div>\n    <p></p>\n    <p>First  repeated   spaces\n      and a\ttab.</p>\n    <ul>\n      <li>One</li>\n      <li>Two</li>\n    </ul>\n  </div>\n";
    const stored =
      "<div>     <div></div>     <div>First  repeated   spaces       and a\ttab.</div>     <ul>       <li>One</li>       <li>Two</li>     </ul>   </div>";
    const f = fixture((path, _body, response) =>
      path === "composer/editNote"
        ? draftResponse(path, undefined, stored)
        : response,
    );
    expect(
      await f.connection.createEmailDraft({ ...htmlDraftInput, body }),
    ).toMatchObject({ verified: true });
    const wire = new URLSearchParams(
      f.requests.find((r) => r.path === "composer/saveModule")?.body,
    ).get("data[html]");
    expect(wire).toBe(
      "<div>     <p></p>     <p>First  repeated   spaces       and a\ttab.</p>     <ul>       <li>One</li>       <li>Two</li>     </ul>   </div>",
    );
  });

  it("allows a link around block content in a flow context", async () => {
    const body = '<a href="https://example.test"><div>Block link</div></a>';
    const f = fixture((path, _body, response) =>
      path === "composer/editNote"
        ? draftResponse(path, undefined, body)
        : response,
    );
    expect(
      await f.connection.createEmailDraft({ ...htmlDraftInput, body }),
    ).toMatchObject({ verified: true });
  });

  it("explicit text mode keeps markup literal and rejects unknown modes", async () => {
    const f = fixture();
    expect(
      await f.connection.createEmailDraft({
        ...draftInput,
        bodyFormat: "text",
      }),
    ).toMatchObject({ verified: true });
    expect(
      () => new EmailDraft({ ...draftInput, bodyFormat: "markdown" as "text" }),
    ).toThrow(FlockbotError);
    const draft = new EmailDraft({
      ...htmlDraftInput,
      body: `<p>${"x".repeat(20001)}</p>`,
    });
    expect(draft.toInput().body?.length).toBe(20008);
    expect(JSON.stringify(draft)).toBe('{"type":"EmailDraft"}');
  });

  it.each(["Example Parish", ""])(
    "creates one verified draft, preserving literal text and distinct IDs without preview or send (upstream sender: %j)",
    async (fromName) => {
      const f = fixture((path, body, response) => {
        if (path === "composer/createNote")
          return {
            ...draftInitialization(),
            noteInfo: { ...draftInitialization().noteInfo, fromName },
          };
        return path === "composer/editNote"
          ? draftResponse(path, body, draftHtml.replace("A ", "A\t"))
          : response;
      });
      expect(
        await f.connection.createEmailDraft({
          ...draftInput,
          body: draftInput.body.replace("A ", "A\t").replaceAll("\n", "\r\n"),
        }),
      ).toEqual({
        noteId: "803",
        url: "https://example-parish.flocknote.com/note/803",
        autosaveId: "801",
        groupId: "101",
        status: "draft",
        verified: true,
      });
      expect(f.requests.map((r) => r.path)).toEqual(sequence);
      const forms = f.requests
        .filter((r) => r.body)
        .map((r) => ({ path: r.path, form: new URLSearchParams(r.body) }));
      expect(
        forms
          .find((r) => r.path === "composer/saveModule")
          ?.form.get("data[html]"),
      ).toBe(
        "<div>A\t&amp;#60;b&amp;#62; &amp;#38;lt; &amp;#34;hi&amp;#34;<br><br>**literal** café 🕊<br></div>",
      );
      for (const { form } of forms.filter((r) => r.path === "composer/save2")) {
        expect(form.get("options[schedule]")).toBe("false");
        expect(form.get("options[route2]")).toBe("false");
        expect(form.get("options[voiceCalls]")).toBe("false");
        expect(form.get("noteTargets[0][groupID]")).toBe("101");
        expect(form.get("fromName")).toBe("");
        expect(form.get("title")).toBe(`Q&A <b> "quoted" O'Neil`);
      }
      expect(
        forms
          .filter((r) => r.path === "composer/save2")
          .map((r) => [
            r.form.get("ID"),
            r.form.get("autosaveID"),
            r.form.get("explicitSaveClick"),
          ]),
      ).toEqual([
        [null, null, "false"],
        [null, "801", "true"],
        ["803", "801", "true"],
      ]);
      expect(
        forms
          .find((r) => r.path === "composer/saveLayout")
          ?.form.get("sections[0][modules][]"),
      ).toBe("811");
    },
  );

  it.each([
    { subject: "" },
    { subject: "a\nb" },
    { subject: "a\u0000b" },
    { subject: "a\tb" },
    { subject: "a\ud800b" },
    { body: " \n" },
    { body: "a\u0000b" },
    { body: "a\udfffb" },
    { body: "<p>a\udfff\udc00b</p>", bodyFormat: "html" as const },
    { body: "a\u007fb", bodyFormat: "text" as const },
    { groupId: "101" },
    { noteId: "803" },
    { html: "<b>wrong mode</b>" },
  ])("rejects invalid or extraneous input before I/O: %j", async (change) => {
    const f = fixture();
    await expect(
      f.connection.createEmailDraft({ ...draftInput, ...change }),
    ).rejects.toMatchObject({
      code: "invalid_input",
      outcome: "not_submitted",
    });
    expect(f.requests).toEqual([]);
  });

  it("has no application character caps and hides content during inspection", () => {
    const input = {
      ...draftInput,
      subject: "S".repeat(201),
      body: "x".repeat(20001),
    };
    const draft = new EmailDraft(input);
    input.body = "changed";
    expect(draft.toInput().body?.length).toBe(20001);
    expect(draft.toInput().subject.length).toBe(201);
    expect(JSON.stringify(draft)).toBe('{"type":"EmailDraft"}');
    expect(inspect(draft)).toBe("EmailDraft {}");
    expect(
      new EmailDraft({ ...draftInput, subject: "X" }).toInput().subject,
    ).toBe("X");
  });

  it.each(["Missing", "Ambiguous"])(
    "does not initialize an unresolved group: %s",
    async (name) => {
      const f = fixture((path, _body, value) =>
        path === "dashboard" && name === "Ambiguous"
          ? '<div class="group_item" data-groupid="101" data-shortname="one"><span class="group_name">Ambiguous</span></div><div class="group_item" data-groupid="102" data-shortname="two"><span class="group_name">Ambiguous</span></div>'
          : value,
      );
      await expect(
        f.connection.createEmailDraft({ ...draftInput, groupName: name }),
      ).rejects.toMatchObject({
        code: name === "Missing" ? "group_not_found" : "group_ambiguous",
        outcome: "not_submitted",
      });
      expect(f.requests.map((r) => r.path)).toEqual(["dashboard"]);
    },
  );

  it.each([
    "networkIsUnderBillingLockout",
    "billingInfoNeededButNetworkIsUnverified",
    "billingInfoNeededFromAdmin",
    "missingNetworkSettingsInfo",
    "ccEnteredPendingSuccessfulCharge",
    "billingInfoNeeded",
    "clickSelectorToExecute",
  ])("stops for the entry gate %s", async (key) => {
    const f = fixture((path, _b, value) =>
      path.includes("writeNewNote")
        ? { ...(value as object), [key]: true }
        : value,
    );
    await expect(
      f.connection.createEmailDraft(draftInput),
    ).rejects.toMatchObject({
      code: "permission_denied",
      outcome: "not_submitted",
      draftProgress: { stage: "entry" },
    });
    expect(f.requests.map((r) => r.path)).toEqual(sequence.slice(0, 3));
  });

  it.each([undefined, "false"])(
    "rejects malformed entry flags: %s",
    async (flag) => {
      const f = fixture((path, _b, value) =>
        path.includes("writeNewNote")
          ? { ...(value as object), networkIsUnderBillingLockout: flag }
          : value,
      );
      await expect(
        f.connection.createEmailDraft(draftInput),
      ).rejects.toMatchObject({
        code: "permission_denied",
        outcome: "not_submitted",
        draftProgress: { stage: "entry" },
      });
      expect(f.requests.map((r) => r.path)).toEqual(sequence.slice(0, 3));
    },
  );

  it.each(["<html>Sign in</html>", { authorized: false }, { success: false }])(
    "diagnoses rejected write responses without replaying a partial draft: %j",
    async (response) => {
      const f = fixture((path, _b, value) => {
        if (path !== "composer/saveModule") return value;
        recordResponse(path, "POST", { status: 200 }, 1);
        return response;
      });
      const code =
        typeof response === "string" ? "invalid_response" : "upstream_rejected";
      const diagnostic = await runDiagnostic("create_email_draft", async () => {
        try {
          await f.connection.createEmailDraft(draftInput);
        } catch (error) {
          expect(error).toMatchObject({
            code,
            outcome: "unknown",
            draftProgress: { stage: "module", autosaveId: "801" },
          });
          return failureDiagnostic(error);
        }
        throw new Error("Expected rejected write");
      });
      expect(diagnostic).toMatchObject({
        failure: {
          stage: "validation",
          endpoint: "composer/saveModule",
          method: "POST",
          status: 200,
          // Preserve the failed response's timing, not total operation time.
          elapsedMs: 1,
          code,
        },
      });
      expect(f.requests.map((r) => r.path)).toEqual([
        ...sequence.slice(0, 6),
        ...(typeof response === "object" && "success" in response
          ? []
          : ["user/userData"]),
      ]);
      expect(await f.connection.status()).toMatchObject({ state: "ready" });
    },
  );

  it("stops a timed-out partial draft even when the pending write later succeeds", async () => {
    let release = (_value: unknown) => {};
    let arrived = () => {};
    const pending = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const f = fixture((path, _b, value) => {
      if (path !== "composer/saveModule") return value;
      arrived();
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const failure = expect(
        f.connection.createEmailDraft(draftInput),
      ).rejects.toMatchObject({
        code: "operation_timeout",
        outcome: "unknown",
        draftProgress: { stage: "module", autosaveId: "801" },
      });
      await pending;
      await vi.advanceTimersByTimeAsync(25_000);
      await failure;
    } finally {
      vi.useRealTimers();
      release({ success: true, itemID: "811" });
      await f.connection.close();
    }
    expect(f.requests.map((r) => r.path)).toEqual(sequence.slice(0, 6));
  });

  it.each([3, 4, 5, 6, 7, 8, 9, 10])(
    "stops after failed request %i without replay and retains known IDs",
    async (stop) => {
      const f = fixture((_p, _b, value, count) => {
        if (count === stop + 1) throw new FlockbotError("transport_failed");
        return value;
      });
      await expect(
        f.connection.createEmailDraft(draftInput),
      ).rejects.toMatchObject({
        outcome: "unknown",
        draftProgress: {
          ...(stop > 4 ? { autosaveId: "801" } : {}),
          ...(stop > 8 ? { noteId: "803" } : {}),
        },
      });
      expect(f.requests.map((r) => r.path)).toEqual(
        sequence.slice(0, stop + 1),
      );
    },
  );

  it.each([2, 4, 8])(
    "retains confirmed IDs on cancellation after response %i and makes no further write",
    async (stop) => {
      const controller = new AbortController();
      const f = fixture((_p, _b, value, count) => {
        if (count === stop + 1) controller.abort();
        return value;
      });
      await expect(
        f.connection.createEmailDraft(draftInput, {
          signal: controller.signal,
        }),
      ).rejects.toMatchObject({
        code: "operation_cancelled",
        outcome: stop < 3 ? "not_submitted" : "unknown",
        draftProgress: {
          ...(stop >= 4 ? { autosaveId: "801" } : {}),
          ...(stop >= 8 ? { noteId: "803" } : {}),
        },
      });
      expect(f.requests.map((r) => r.path)).toEqual(
        sequence.slice(0, stop + 1),
      );
    },
  );

  it.each([
    "status",
    "target",
    "body",
    "injected",
    "sender",
    "null sender",
    "missing sender",
    "schedule",
    "type",
    "identity",
    "theme",
    "route2",
    "voiceCalls",
    "col2",
    "attributes",
    "subject",
  ])("does not claim verified success for mismatched %s", async (field) => {
    const response = draftReadback();
    if (field === "subject")
      response.noteInfo.title =
        "Q&amp;A &lt;b&gt; &quot;quoted&quot; O&#39;Neil";
    if (field === "status") response.noteInfo.status = "published";
    if (field === "type") response.noteInfo.type = "sms";
    if (field === "identity") response.noteInfo.ID = 999;
    if (field === "target") response.noteInfo.noteTargets[0]!.groupID = "999";
    if (field === "sender") response.noteInfo.fromName = "Other sender";
    if (field === "null sender")
      Object.assign(response.noteInfo, { fromName: null });
    if (field === "missing sender")
      Reflect.deleteProperty(response.noteInfo, "fromName");
    if (field === "schedule") response.noteInfo.options.schedule = true;
    if (field === "theme") response.noteInfo.themeID = 99;
    if (field === "route2") response.noteInfo.options.route2 = true;
    if (field === "voiceCalls") response.noteInfo.options.voiceCalls = true;
    if (field === "col2")
      response.noteInfo.sections[0]!.col2.items.push({
        type: "text",
        data: { html: "extra" },
      });
    if (field === "attributes")
      response.noteInfo.sections[0]!.col1.items[0]!.data.html =
        response.noteInfo.sections[0]!.col1.items[0]!.data.html.replace(
          "<div>",
          "<div hidden>",
        );
    if (field === "body")
      response.noteInfo.sections[0]!.col1.items[0]!.data.html =
        "<div>other</div>";
    if (field === "injected")
      response.noteInfo.sections[0]!.col1.items[0]!.data.html =
        "<div>A <b></b>&#60;b&#62; &#38;lt; &#34;hi&#34;<br><br>**literal** café 🕊<br></div>";
    const f = fixture((p, _b, v) => (p === "composer/editNote" ? response : v));
    await expect(
      f.connection.createEmailDraft(draftInput),
    ).rejects.toMatchObject({
      code: "invalid_response",
      outcome: "unknown",
      draftProgress: { stage: "verify", noteId: "803", autosaveId: "801" },
    });
  });

  it.each([8, 9])(
    "stops on an identity mismatch at save request %i",
    async (stop) => {
      const f = fixture((_p, _b, value, count) =>
        count === stop + 1
          ? { success: true, note: { ID: "801", autosaveID: "801" } }
          : value,
      );
      await expect(
        f.connection.createEmailDraft(draftInput),
      ).rejects.toMatchObject({
        reason: "note_identity_mismatch",
        outcome: "unknown",
        draftProgress: {
          stage: stop === 8 ? "materialize" : "metadata",
          autosaveId: "801",
        },
      });
      expect(f.requests.map((r) => r.path)).toEqual(
        sequence.slice(0, stop + 1),
      );
    },
  );

  it("rejects unsupported initialized targets before saving and keeps the outcome conservative", async () => {
    const response = draftInitialization();
    response.noteInfo.noteTargets[0]!.isSmartGroup = true;
    const f = fixture((p, _b, v) =>
      p === "composer/createNote" ? response : v,
    );
    await expect(
      f.connection.createEmailDraft(draftInput),
    ).rejects.toMatchObject({
      reason: "note_targets_shape",
      outcome: "unknown",
      draftProgress: { stage: "initialize" },
    });
    expect(f.requests.map((r) => r.path)).toEqual(sequence.slice(0, 4));
  });

  it("also exposes the shared model independently of its browser adapter", async () => {
    const f = fixture();
    expect(
      await new EmailDraft(draftInput).create(
        f.context,
        new Network("example-parish"),
      ),
    ).toMatchObject({ verified: true, noteId: "803" });
  });
});

describe("uploaded draft images", () => {
  function files() {
    const directory = mkdtempSync(join(tmpdir(), "flockbot-image-test-"));
    const jpeg = Buffer.from([255, 216, 255, 224, 10, 20, 30]);
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 40, 50]);
    const first = join(directory, "private-photo.jpg"),
      second = join(directory, "second.png");
    writeFileSync(first, jpeg);
    writeFileSync(second, png);
    cleanup.push(async () => {
      rmSync(directory, { recursive: true, force: true });
    });
    return { directory, first, second, jpeg, png };
  }

  it("uploads validated snapshots and verifies interleaved photo identities", async () => {
    const images = files(),
      response = imageDraftResponse();
    const uploads: DraftImage[] = [];
    const f = fixture((path, body, _r, _n, photo) => {
      if (path === "dashboard")
        writeFileSync(images.first, "changed after validation");
      if (photo) uploads.push(photo);
      return response(path, body);
    });
    expect(
      await f.connection.createEmailDraft(
        imageDraftInput(images.first, images.second),
      ),
    ).toMatchObject({ verified: true, noteId: "803" });
    expect(uploads.map((p) => Buffer.from(p.base64, "base64"))).toEqual([
      images.jpeg,
      images.png,
    ]);
    expect(uploads.map((p) => [p.filename, p.mime])).toEqual([
      [expect.stringMatching(/^[0-9a-f-]{36}\.jpg$/), "image/jpeg"],
      [expect.stringMatching(/^[0-9a-f-]{36}\.png$/), "image/png"],
    ]);
    const modules = f.requests
      .filter((r) => r.path === "composer/saveModule")
      .map((r) => new URLSearchParams(r.body));
    expect(modules.map((p) => p.get("type"))).toEqual([
      "photo",
      "button",
      "photo",
    ]);
    expect(modules.map((p) => p.get("data[photoID]"))).toEqual([
      "901",
      null,
      "902",
    ]);
    expect(
      new URLSearchParams(
        f.requests.find((r) => r.path === "composer/saveLayout")!.body,
      ).getAll("sections[0][modules][]"),
    ).toEqual(["811", "812", "813"]);
  });

  it("preserves verified success when snapshot cleanup fails", async () => {
    const images = files(),
      response = imageDraftResponse();
    const f = fixture((path, body) => response(path, body));
    const remove = vi
      .spyOn(fsPromises, "rm")
      .mockRejectedValue(Object.assign(new Error("locked"), { code: "EBUSY" }));
    syncBuiltinESMExports();
    try {
      expect(
        await f.connection.createEmailDraft(
          imageDraftInput(images.first, images.second),
        ),
      ).toMatchObject({ verified: true, noteId: "803" });
    } finally {
      const paths = remove.mock.calls.map(([path]) => path);
      remove.mockRestore();
      syncBuiltinESMExports();
      for (const path of paths)
        await fsPromises.rm(path, { recursive: true, force: true });
    }
  });

  it.each([
    "missing",
    "directory",
    "empty",
    "mismatch",
    "unsupported",
    "relative",
    "oversized",
  ])("rejects %s files before any remote request", async (kind) => {
    const images = files();
    let second = images.second;
    if (kind === "missing") second += ".missing.png";
    if (kind === "directory") {
      second = join(images.directory, "directory.png");
      mkdirSync(second);
    }
    if (kind === "empty") writeFileSync(second, "");
    if (kind === "mismatch") writeFileSync(second, images.jpeg);
    if (kind === "unsupported") {
      second += ".webp";
      writeFileSync(second, images.png);
    }
    if (kind === "relative") second = "photo.png";
    if (kind === "oversized") writeFileSync(second, Buffer.alloc(12_000_001));
    const f = fixture();
    const error = await f.connection
      .createEmailDraft(imageDraftInput(images.first, second))
      .catch((e) => e);
    expect(error).toMatchObject({
      code: "invalid_input",
      reason: "draft_image_file",
      outcome: "not_submitted",
    });
    expect(JSON.stringify(error)).not.toContain(images.directory);
    expect(f.requests).toEqual([]);
  });

  it("accepts the exact browser size ceiling and GIF signatures", async () => {
    const images = files(),
      data = Buffer.alloc(12_000_000);
    images.jpeg.copy(data);
    writeFileSync(images.first, data);
    const gif = join(images.directory, "animated.gif");
    writeFileSync(gif, Buffer.from("GIF89a\x01\x00\x01\x00"));
    const response = imageDraftResponse();
    const uploads: DraftImage[] = [];
    const f = fixture((p, b, _r, _n, photo) => {
      if (photo) uploads.push(photo);
      return response(p, b);
    });
    expect(
      await f.connection.createEmailDraft(imageDraftInput(images.first, gif)),
    ).toMatchObject({ verified: true });
    expect(Buffer.from(uploads[0]!.base64, "base64").length).toBe(12_000_000);
    expect(uploads[1]!.mime).toBe("image/gif");
  });

  it.each(["identity", "dimensions", "link", "extra"])(
    "does not verify changed photo %s",
    async (kind) => {
      const images = files(),
        response = imageDraftResponse();
      const f = fixture((p, b) => {
        const r = response(p, b) as ReturnType<typeof draftReadback>;
        if (p === "composer/editNote") {
          const data = r.noteInfo.sections[0]!.col1.items[0]!.data as Record<
            string,
            unknown
          >;
          if (kind === "identity") data.photoID = "999";
          if (kind === "dimensions")
            data.photodimensions = { width: 0, height: 120 };
          if (kind === "link") data.photourl = "javascript:alert(1)";
          if (kind === "extra") data.photolink = "https://example.test/changed";
        }
        return r;
      });
      await expect(
        f.connection.createEmailDraft(
          imageDraftInput(images.first, images.second),
        ),
      ).rejects.toMatchObject({
        reason: "draft_verification",
        outcome: "unknown",
        draftProgress: {
          stage: "verify",
          photoIds: ["901", "902"],
          noteId: "803",
        },
      });
    },
  );

  it.each(["rejected", "malformed", "transport", "later-save"])(
    "retains uploaded IDs without replay after %s failure",
    async (kind) => {
      const images = files(),
        response = imageDraftResponse();
      let uploads = 0;
      const f = fixture((p, b) => {
        if (p === "upload/photo/note" && ++uploads === 2) {
          if (kind === "rejected") return { success: false };
          if (kind === "malformed") return { success: true, photoID: null };
          if (kind === "transport") throw new FlockbotError("transport_failed");
        }
        if (kind === "later-save" && p === "composer/saveSection")
          throw new FlockbotError("transport_failed");
        return response(p, b);
      });
      await expect(
        f.connection.createEmailDraft(
          imageDraftInput(images.first, images.second),
        ),
      ).rejects.toMatchObject({
        outcome: "unknown",
        draftProgress: {
          stage: kind === "later-save" ? "section" : "upload",
          photoIds: kind === "later-save" ? ["901", "902"] : ["901"],
          autosaveId: "801",
        },
      });
      expect(uploads).toBe(2);
      expect(f.requests.some((r) => r.path === "composer/editNote")).toBe(
        false,
      );
    },
  );

  it("stops after cancellation during upload without a late module save", async () => {
    const images = files(),
      response = imageDraftResponse(),
      controller = new AbortController();
    let release!: () => void,
      entered = false;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = fixture(async (p, b) => {
      if (p === "upload/photo/note") {
        entered = true;
        await blocked;
      }
      return response(p, b);
    });
    const result = f.connection
      .createEmailDraft(imageDraftInput(images.first, images.second), {
        signal: controller.signal,
      })
      .catch((e) => e);
    await vi.waitFor(() => expect(entered).toBe(true));
    controller.abort();
    expect(await result).toMatchObject({
      code: "operation_cancelled",
      outcome: "unknown",
      draftProgress: { stage: "upload", autosaveId: "801" },
    });
    release();
    await f.connection.close();
    expect(
      f.requests.filter((r) => r.path === "upload/photo/note"),
    ).toHaveLength(1);
    expect(f.requests.some((r) => r.path === "composer/saveModule")).toBe(
      false,
    );
  });
});
