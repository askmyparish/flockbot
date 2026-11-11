import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EmailDraft, FlockbotError, Network } from "../../src/index.js";
import { BrowserConnection } from "../../adapters/mcp/src/browser-connection.js";
import { SerialCoordinator } from "../../adapters/mcp/src/serial-coordinator.js";
import {
  draftInput,
  draftResponse,
  draftReadback,
  draftInitialization,
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
  ) => unknown,
) {
  const requests: {
    path: string;
    method: string;
    body?: string | undefined;
  }[] = [];
  const request = async (path: string, method = "GET", body?: string) => {
    requests.push({ path, method, body });
    const response = draftResponse(path, body);
    return change ? change(path, body, response, requests.length) : response;
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
  it("creates one verified draft, preserving literal text and distinct IDs without preview or send", async () => {
    const f = fixture();
    expect(
      await f.connection.createEmailDraft({
        ...draftInput,
        body: draftInput.body.replaceAll("\n", "\r\n"),
      }),
    ).toEqual({
      noteId: "803",
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
      "<div>A &amp;#60;b&amp;#62; &amp;#38;lt; &amp;#34;hi&amp;#34;<br><br>**literal** café 🕊<br></div>",
    );
    for (const { form } of forms.filter((r) => r.path === "composer/save2")) {
      expect(form.get("options[schedule]")).toBe("false");
      expect(form.get("options[route2]")).toBe("false");
      expect(form.get("options[voiceCalls]")).toBe("false");
      expect(form.get("noteTargets[0][groupID]")).toBe("101");
      expect(form.get("fromName")).toBe("Example Parish");
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
  });

  it.each([
    { subject: "" },
    { subject: "a\nb" },
    { body: " \n" },
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
    expect(draft.toInput().body.length).toBe(20001);
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

  it.each(["<html>Sign in</html>", { authorized: false }])(
    "diagnoses auth-like failures without replaying a partial draft: %j",
    async (response) => {
      const f = fixture((path, _b, value) =>
        path === "composer/saveModule" ? response : value,
      );
      await expect(
        f.connection.createEmailDraft(draftInput),
      ).rejects.toMatchObject({
        code:
          typeof response === "string"
            ? "invalid_response"
            : "upstream_rejected",
        outcome: "unknown",
        draftProgress: { stage: "module", autosaveId: "801" },
      });
      expect(f.requests.map((r) => r.path)).toEqual([
        ...sequence.slice(0, 6),
        "user/userData",
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
