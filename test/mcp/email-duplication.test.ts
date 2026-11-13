import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BrowserConnection } from "../../adapters/mcp/src/browser-connection.js";
import { SerialCoordinator } from "../../adapters/mcp/src/serial-coordinator.js";
import { FlockbotError } from "../../src/errors.js";
import { duplicationFixture } from "../fixtures/email-duplication.js";
import {
  runDiagnostic,
  recordResponse,
  responseError,
  failureDiagnostic,
} from "../../adapters/mcp/src/diagnostics.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
function fixture(
  change?: (
    path: string,
    body: string | undefined,
    response: unknown,
  ) => unknown,
) {
  const data = duplicationFixture();
  const requests: {
    path: string;
    method: string;
    body?: string | undefined;
  }[] = [];
  const profile = mkdtempSync(join(tmpdir(), "flockbot-duplicate-"));
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
      signIn: async () => {},
      close: async () => {},
      request: async (path, method = "GET", body) => {
        requests.push({ path, method, body });
        const result = data.response(path, body);
        return change ? change(path, body, result) : result;
      },
    }),
  });
  cleanup.push(async () => {
    await connection.close();
    rmSync(profile, { recursive: true, force: true });
  });
  return {
    ...data,
    connection,
    requests,
    run: () => connection.duplicateEmailDraft({ noteId: "00801" }),
  };
}

describe("native published email duplication", () => {
  it("rejects invalid identities and overrides without requests", async () => {
    const f = fixture();
    for (const input of [
      { noteId: "../801" },
      { noteId: "0" },
      { noteId: "801", subject: "Override" },
    ]) {
      await expect(
        f.connection.duplicateEmailDraft(input),
      ).rejects.toMatchObject({
        code: "invalid_input",
        outcome: "not_submitted",
      });
    }
    expect(f.requests).toEqual([]);
  });

  it("never writes metadata to an aliased source identity returned by materialization", async () => {
    const f = fixture((path, _body, response) =>
      path === "composer/save2"
        ? {
            success: true,
            note: { ID: 801, autosaveID: "802", status: "draft" },
          }
        : response,
    );
    await expect(f.run()).rejects.toMatchObject({
      reason: "duplicate_verification",
      outcome: "unknown",
      draftProgress: { autosaveId: "802" },
    });
    expect(f.requests.filter((r) => r.path === "composer/save2")).toHaveLength(
      1,
    );
  });

  it("retains both identities on a failed final-ID metadata save", async () => {
    const f = fixture((path, body, response) => {
      if (
        path === "composer/save2" &&
        new URLSearchParams(body).get("ID") === "803"
      )
        throw new FlockbotError("transport_failed");
      return response;
    });
    await expect(f.run()).rejects.toMatchObject({
      outcome: "unknown",
      draftProgress: { noteId: "803", autosaveId: "802", stage: "metadata" },
    });
    expect(
      f.requests.filter((r) => r.path === "composer/duplicateNote"),
    ).toHaveLength(1);
    expect(f.requests.filter((r) => r.path === "composer/save2")).toHaveLength(
      2,
    );
  });

  it.each(["The Choir", ""])(
    "copies raw multi-section content and all ordinary groups with an empty new sender (source: %j)",
    async (fromName) => {
      const f = fixture();
      f.source.fromName = fromName;
      f.duplicate.fromName = fromName;
      const original = structuredClone(f.source);
      f.persisted.noteTargets.reverse();
      expect(await f.run()).toEqual({
        sourceNoteId: "801",
        noteId: "803",
        autosaveId: "802",
        groupIds: ["101", "102"],
        status: "draft",
        verified: true,
        url: "https://example-parish.flocknote.com/note/803",
      });
      expect(f.source).toEqual(original);
      expect(f.requests.map((r) => r.path)).toEqual([
        "composer/editNote",
        "network/getMetadata",
        "dashboard",
        "composer/duplicateNote",
        "composer/save2",
        "composer/save2",
        "composer/editNote",
      ]);
      expect(f.requests[3]?.body).toBe("groupID=&noteID=801&fromComposer=1");
      const saves = f.requests
        .filter((r) => r.path === "composer/save2")
        .map((r) => new URLSearchParams(r.body));
      expect(saves.map((p) => [p.get("ID"), p.get("status")])).toEqual([
        ["0", "autosaved"],
        ["803", "draft"],
      ]);
      for (const p of saves) {
        expect(p.get("autosaveID")).toBe("802");
        expect(p.get("fromName")).toBe("");
        expect(p.get("title")).toBe("Annual choir plans");
        expect([
          p.get("noteTargets[0][groupID]"),
          p.get("noteTargets[1][groupID]"),
        ]).toEqual(["101", "102"]);
        for (const key of ["schedule", "route2", "voiceCalls"])
          expect(p.get(`options[${key}]`)).toBe("false");
        expect(p.get("explicitSaveClick")).toBe("true");
        expect(p.get("noteTargets[0][ID]")).toBe("");
        expect(p.get("noteTargets[1][ID]")).toBe("");
        expect([...p.values()]).not.toContain("801");
        expect([...p.values()]).not.toContain("841");
        expect([...p.values()]).not.toContain("842");
        expect(p.get("returnVoiceData")).toBe("false");
        expect(
          [...p.keys()].some((key) =>
            /sections|html|photourl|base64/i.test(key),
          ),
        ).toBe(false);
      }
    },
  );

  it.each([
    [
      "status",
      (f: ReturnType<typeof fixture>) => {
        f.source.status = "draft";
      },
    ],
    [
      "channel",
      (f: ReturnType<typeof fixture>) => {
        f.source.type = "sms";
      },
    ],
    [
      "parish",
      (f: ReturnType<typeof fixture>) => {
        f.source.networkID = 999;
      },
    ],
    [
      "identity",
      (f: ReturnType<typeof fixture>) => {
        f.source.ID = 999;
      },
    ],
    [
      "smart group",
      (f: ReturnType<typeof fixture>) => {
        f.source.noteTargets[0]!.isSmartGroup = true;
      },
    ],
    [
      "filtered group",
      (f: ReturnType<typeof fixture>) => {
        f.source.noteTargets[0]!.isFilteredGroup = true;
      },
    ],
    [
      "contacts",
      (f: ReturnType<typeof fixture>) => {
        f.source.noteTargets[0]!.includeContacts = true;
      },
    ],
    [
      "unavailable group",
      (f: ReturnType<typeof fixture>) => {
        f.source.noteTargets[1]!.groupID = "999";
        f.source.noteTargets[1]!.entityID = "999";
      },
    ],
    [
      "duplicate groups",
      (f: ReturnType<typeof fixture>) => {
        f.source.noteTargets.push(f.source.noteTargets[0]!);
      },
    ],
    [
      "unknown module",
      (f: ReturnType<typeof fixture>) => {
        f.source.sections[0]!.col1.items[0]!.type = "poll";
      },
    ],
    [
      "layout",
      (f: ReturnType<typeof fixture>) => {
        f.source.sections[0]!.layout = "2";
      },
    ],
  ] as const)(
    "rejects unsupported %s before any write",
    async (name, change) => {
      const f = fixture();
      change(f);
      await expect(f.run()).rejects.toMatchObject({
        code: name === "parish" ? "invalid_response" : "draft_not_submitted",
        outcome: "not_submitted",
        reason: {
          status: "duplicate_source_unsupported",
          channel: "duplicate_source_unsupported",
          parish: "origin_mismatch",
          identity: "note_identity_mismatch",
          "smart group": "duplicate_targets_unsupported",
          "filtered group": "duplicate_targets_unsupported",
          contacts: "duplicate_targets_unsupported",
          "unavailable group": "duplicate_targets_unsupported",
          "duplicate groups": "duplicate_targets_unsupported",
          "unknown module": "duplicate_content_unsupported",
          layout: "duplicate_content_unsupported",
        }[name],
      });
      expect(f.requests.some((r) => /duplicateNote|save/.test(r.path))).toBe(
        false,
      );
    },
  );

  it.each([null, undefined, 42])(
    "rejects a non-string source sender before writes (%j)",
    async (fromName) => {
      const f = fixture();
      Object.assign(f.source, { fromName });
      await expect(f.run()).rejects.toMatchObject({
        code: "draft_not_submitted",
        reason: "duplicate_source_unsupported",
        outcome: "not_submitted",
      });
      expect(f.requests.some((r) => /duplicateNote|save/.test(r.path))).toBe(
        false,
      );
    },
  );

  it.each(["composer/editNote", "composer/save2"])(
    "preserves transport diagnostics from %s without replay",
    async (at) =>
      runDiagnostic("duplicate_email_draft", async () => {
        const f = fixture((path, _body, response) => {
          if (path !== at) return response;
          throw responseError(
            new FlockbotError(
              "invalid_response",
              200,
              undefined,
              undefined,
              "response_too_large",
            ),
            recordResponse(
              path,
              "POST",
              {
                status: 200,
                bytes: 1_048_577,
                contentType: "json",
                reason: "response_too_large",
              },
              1,
            ),
          );
        });
        const error = await f.run().catch((error: unknown) => error);
        expect(error).toMatchObject({
          code: "invalid_response",
          reason: "response_too_large",
          outcome: at === "composer/editNote" ? "not_submitted" : "unknown",
        });
        expect(failureDiagnostic(error).failure).toMatchObject({
          stage: "transport",
          endpoint: at,
          status: 200,
          bytes: 1_048_577,
          reason: "response_too_large",
        });
        expect(f.requests.filter((r) => r.path === at)).toHaveLength(1);
      }),
  );

  it.each(["composer/editNote", "composer/save2"])(
    "diagnoses an HTML %s response without replaying the operation",
    async (at) =>
      runDiagnostic("duplicate_email_draft", async () => {
        const f = fixture((path, _body, response) =>
          path === at ? "<html>Sign in</html>" : response,
        );
        const error = await f.run().catch((error: unknown) => error);
        expect(error).toMatchObject({
          code: "invalid_response",
          reason: "unexpected_html",
          outcome: at === "composer/editNote" ? "not_submitted" : "unknown",
        });
        expect(failureDiagnostic(error).authentication).toBe("authenticated");
        expect(f.requests.filter((r) => r.path === at)).toHaveLength(1);
        expect(await f.connection.status()).toMatchObject({ state: "ready" });
      }),
  );

  it("keeps malformed source responses distinct from unsupported source emails", async () => {
    const f = fixture((path, _body, response) =>
      path === "composer/editNote" ? {} : response,
    );
    await expect(f.run()).rejects.toMatchObject({
      code: "invalid_response",
      reason: "expected_success",
      outcome: "not_submitted",
    });
    expect(f.requests.some((r) => /duplicateNote|save/.test(r.path))).toBe(
      false,
    );
  });

  it.each(["schedule", "route2", "voiceCalls", "scheduleTime"])(
    "rejects unsupported source delivery setting %s before duplication",
    async (key) => {
      const f = fixture();
      Object.assign(f.source.options, {
        [key]: key === "scheduleTime" ? 1800000000 : true,
      });
      await expect(f.run()).rejects.toMatchObject({
        code: "draft_not_submitted",
        outcome: "not_submitted",
        reason: "duplicate_source_unsupported",
      });
      expect(f.requests.some((r) => /duplicateNote|save/.test(r.path))).toBe(
        false,
      );
    },
  );

  it.each(["composer/duplicateNote", "composer/save2", "verify"])(
    "never replays a failed %s and retains known IDs",
    async (at) => {
      const f = fixture((path, body, response) => {
        if (
          path === at ||
          (at === "verify" &&
            path === "composer/editNote" &&
            new URLSearchParams(body).get("noteID") === "803")
        )
          throw new FlockbotError("transport_failed");
        return response;
      });
      await expect(f.run()).rejects.toMatchObject({
        code: "transport_failed",
        outcome: "unknown",
        draftProgress: {
          ...(at === "composer/duplicateNote" ? {} : { autosaveId: "802" }),
          ...(at === "verify" ? { noteId: "803" } : {}),
        },
      });
      expect(
        f.requests.filter((r) => r.path === "composer/duplicateNote"),
      ).toHaveLength(1);
      expect(
        f.requests.filter((r) => r.path === "composer/save2"),
      ).toHaveLength(
        at === "composer/duplicateNote" ? 0 : at === "verify" ? 2 : 1,
      );
    },
  );

  it.each([
    "html",
    "photo",
    "image URL",
    "dimensions",
    "targets",
    "smart target",
    "module type",
    "options",
    "schedule",
    "theme",
    "layout",
  ])(
    "rejects persisted %s mismatches rather than claiming a faithful copy",
    async (field) => {
      const f = fixture();
      if (field === "html")
        Object.assign(f.persisted.sections[0]!.col1.items[0]!.data, {
          html: "changed",
        });
      if (field === "photo")
        Object.assign(f.persisted.sections[1]!.col1.items[0]!.data, {
          photoID: 999,
        });
      if (field === "image URL")
        Object.assign(f.persisted.sections[1]!.col1.items[0]!.data, {
          photourl: "https://images.example.test/other.png",
        });
      if (field === "dimensions")
        Object.assign(f.persisted.sections[1]!.col1.items[0]!.data, {
          photodimensions: { width: 1560, height: 399 },
        });
      if (field === "targets") f.persisted.noteTargets.pop();
      if (field === "smart target")
        f.persisted.noteTargets[0]!.isSmartGroup = true;
      if (field === "module type")
        f.persisted.sections[0]!.col1.items[0]!.type = "poll";
      if (field === "options") f.persisted.options.replyToGive.enabled = true;
      if (field === "schedule") f.persisted.options.schedule = true;
      if (field === "theme") f.persisted.themeID = 5;
      if (field === "layout") f.persisted.sections.reverse();
      await expect(f.run()).rejects.toMatchObject({
        outcome: "unknown",
        reason: "duplicate_verification",
        draftProgress: { noteId: "803", autosaveId: "802", stage: "verify" },
      });
    },
  );

  it.each(["The Choir", null, undefined])(
    "rejects a persisted sender that is not empty (%j)",
    async (fromName) => {
      const f = fixture((path, body, response) => {
        if (
          path === "composer/editNote" &&
          new URLSearchParams(body).get("noteID") === "803"
        )
          Object.assign((response as { noteInfo: object }).noteInfo, {
            fromName,
          });
        return response;
      });
      await expect(f.run()).rejects.toMatchObject({
        outcome: "unknown",
        reason: "duplicate_verification",
        draftProgress: { noteId: "803", autosaveId: "802", stage: "verify" },
      });
      expect(
        f.requests.filter((r) => r.path === "composer/duplicateNote"),
      ).toHaveLength(1);
      expect(
        f.requests.filter((r) => r.path === "composer/save2"),
      ).toHaveLength(2);
    },
  );

  it("stops on a changed native copy before either save", async () => {
    const f = fixture();
    Object.assign(f.duplicate.sections[0]!.col1.items[0]!.data, {
      html: "concurrent edit",
    });
    await expect(f.run()).rejects.toMatchObject({
      reason: "duplicate_verification",
      outcome: "unknown",
      draftProgress: { autosaveId: "802" },
    });
    expect(f.requests.filter((r) => r.path === "composer/save2")).toHaveLength(
      0,
    );
  });
});
