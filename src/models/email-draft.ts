import { parseFragment, type DefaultTreeAdapterMap } from "parse5";
import { FlockbotError, type DraftProgress } from "../errors.js";
import { identifier } from "./identifier.js";
import {
  membershipGroupSelector,
  type GroupSelector,
} from "./member-groups.js";
import type { Network } from "./network.js";
import { invalidResponse, record, successful, text } from "./parsing.js";
import type { ResourceQuery } from "./resource-read.js";

export interface EmailDraftInput extends GroupSelector {
  readonly subject: string;
  readonly body: string;
}
export interface EmailDraftResult {
  readonly noteId: string;
  readonly autosaveId: string;
  readonly groupId: string;
  readonly status: "draft";
  readonly verified: true;
}
export interface DraftContext extends ResourceQuery {
  /** Submit once. The caller owns authentication, coordination and diagnostics. */
  compose(path: string, body: string): Promise<unknown>;
}

function form(value: Record<string, unknown>): string {
  const data = new URLSearchParams();
  const append = (key: string, item: unknown) => {
    if (Array.isArray(item)) {
      item.forEach((child, i) => {
        append(`${key}[${typeof child === "object" ? i : ""}]`, child);
      });
    } else if (item !== null && typeof item === "object") {
      for (const [name, child] of Object.entries(item))
        append(`${key}[${name}]`, child);
    } else if (item !== undefined)
      data.append(key, item === null ? "" : String(item));
  };
  for (const [key, item] of Object.entries(value)) append(key, item);
  return data.toString();
}

function id(value: unknown): string {
  const result = identifier(value);
  if (!/^\d{1,128}$/.test(result))
    return invalidResponse("expected_identifier");
  return result;
}

function target(value: unknown, groupId: string): Record<string, unknown> {
  if (!Array.isArray(value) || value.length !== 1)
    return invalidResponse("note_targets_shape");
  const row = record(value[0]);
  if (
    id(row.groupID) !== groupId ||
    id(row.entityID) !== groupId ||
    row.targetType !== "group" ||
    row.targetTypeDictID !== 1 ||
    row.isParent !== false ||
    row.includeContacts !== false ||
    row.isSmartGroup !== false ||
    row.isFilteredGroup !== false ||
    typeof row.isEveryoneGroup !== "boolean"
  )
    return invalidResponse("note_targets_shape");
  return Object.fromEntries(
    [
      "ID",
      "entityID",
      "groupID",
      "targetType",
      "targetTypeDictID",
      "isParent",
      "includeContacts",
      "isSmartGroup",
      "isFilteredGroup",
      "isEveryoneGroup",
    ].map((key) => [key, key === "ID" ? null : row[key]]),
  );
}

function persistedText(value: unknown): string {
  if (typeof value !== "string") return invalidResponse("draft_verification");
  const root = parseFragment(value);
  const div = root.childNodes[0];
  if (
    root.childNodes.length !== 1 ||
    !div ||
    !("tagName" in div) ||
    div.tagName !== "div"
  )
    return invalidResponse("draft_verification");
  function read(node: DefaultTreeAdapterMap["childNode"]): string {
    if (node.nodeName === "#text" && "value" in node) return node.value;
    if (
      !("tagName" in node) ||
      node.attrs.length ||
      !["div", "br"].includes(node.tagName)
    )
      return invalidResponse("draft_verification");
    if (node.tagName === "br") return "\n";
    if (node !== div) return invalidResponse("draft_verification");
    return node.childNodes.map(read).join("");
  }
  return read(div);
}

/** One create-only intent. Private content never appears in inspection/JSON output. */
export class EmailDraft {
  readonly #input: EmailDraftInput;
  #progress: DraftProgress = { stage: "resolve_group", completedStages: [] };
  #submitted = false;
  constructor(input: EmailDraftInput) {
    try {
      if (
        !input ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        Object.keys(input).some(
          (k) => !["groupId", "groupName", "subject", "body"].includes(k),
        ) ||
        typeof input.subject !== "string" ||
        !input.subject.trim() ||
        /[\r\n]/.test(input.subject) ||
        typeof input.body !== "string" ||
        !input.body.trim()
      )
        throw new Error();
      this.#input = Object.freeze({
        ...membershipGroupSelector(input),
        subject: input.subject.trim(),
        body: input.body.replace(/\r\n?/g, "\n"),
      });
    } catch {
      throw new FlockbotError("invalid_input", undefined, "not_submitted");
    }
  }
  toInput(): EmailDraftInput {
    return { ...this.#input };
  }
  toJSON(): object {
    return { type: "EmailDraft" };
  }
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return "EmailDraft {}";
  }
  get progress(): DraftProgress {
    return {
      ...this.#progress,
      completedStages: [...this.#progress.completedStages],
    };
  }
  get submitted(): boolean {
    return this.#submitted;
  }

  async create(
    context: DraftContext,
    network: Network,
  ): Promise<EmailDraftResult> {
    const input = this.#input;
    context.check();
    const group = input.groupId
      ? (await network.discoverGroups(context)).find(
          (g) => g.id === input.groupId,
        )
      : await network.findGroup(context, input.groupName!);
    if (!group) throw new FlockbotError("group_not_found");
    const groupId = id(group.id);
    const metadata = successful(await context.read("network/getMetadata"));
    const networkId = id(metadata.networkID);
    const done = () => {
      this.#progress = {
        ...this.#progress,
        completedStages: [
          ...this.#progress.completedStages,
          this.#progress.stage,
        ],
      };
    };
    done();
    const request = async (
      stage: DraftProgress["stage"],
      path: string,
      body: Record<string, unknown>,
      persist = true,
    ) => {
      this.#progress = { ...this.#progress, stage };
      context.check();
      if (persist) this.#submitted = true;
      return record(await context.compose(path, form(body)));
    };
    const entry = await request(
      "entry",
      `network/${networkId}/writeNewNote?ajax`,
      { groupID: groupId, openComposerAfter: 1 },
      false,
    );
    for (const key of [
      "networkIsUnderBillingLockout",
      "billingInfoNeededButNetworkIsUnverified",
      "billingInfoNeededFromAdmin",
      "missingNetworkSettingsInfo",
    ])
      if (entry[key] !== false)
        throw new FlockbotError(
          "permission_denied",
          undefined,
          undefined,
          undefined,
          "draft_entry_blocked",
        );
    if (
      entry.ccEnteredPendingSuccessfulCharge ||
      entry.billingInfoNeeded != null ||
      entry.clickSelectorToExecute ||
      entry.openComposerAfter !== true
    )
      throw new FlockbotError(
        "permission_denied",
        undefined,
        undefined,
        undefined,
        "draft_entry_blocked",
      );
    done();
    const initialized = successful(
      await request("initialize", "composer/createNote", {
        type: "email",
        groupID: groupId,
      }),
    );
    const note = record(initialized.noteInfo);
    if (
      note.ID != null ||
      note.autosaveID != null ||
      note.type !== "email" ||
      note.status !== "autosaved" ||
      note.newNote !== true ||
      id(note.networkID) !== networkId ||
      !Array.isArray(note.sections) ||
      note.sections.length
    )
      return invalidResponse("draft_initialization");
    const selectedTarget = target(note.noteTargets, groupId);
    const fromName = text(note.fromName);
    const userId = id(note.userID);
    if (!Number.isSafeInteger(note.themeID) || (note.themeID as number) < 0)
      return invalidResponse("draft_initialization");
    const defaults = record(note.options);
    for (const key of ["comments", "includeLink", "includeGroupHeader"])
      if (typeof defaults[key] !== "boolean")
        return invalidResponse("draft_initialization");
    const payload = {
      type: "email",
      title: input.subject,
      fromName,
      networkID: networkId,
      userID: userId,
      themeID: note.themeID,
      newNote: true,
      duplicate: false,
      status: "autosaved",
      autosaved: 1,
      explicitSaveClick: false,
      noteTargets: [selectedTarget],
      returnVoiceData: false,
      options: {
        comments: defaults.comments,
        includeLink: defaults.includeLink,
        includeGroupHeader: defaults.includeGroupHeader,
        schedule: false,
        route2: false,
        voiceCalls: false,
        replyToGive: { enabled: false },
      },
    };
    done();
    const saved = successful(
      await request("autosave", "composer/save2", payload),
    );
    const autosave = record(saved.note);
    const autosaveId = id(autosave.autosaveID);
    this.#progress = { ...this.#progress, autosaveId };
    if (autosave.ID != null || autosave.newNote !== false)
      return invalidResponse("draft_initialization");
    done();
    // Flocknote decodes ordinary named entities in this protocol. Numeric references
    // with an escaped ampersand survive the save/read path as literal text.
    const html = `<div>${input.body.replace(/[&<>"']/g, (c) => `&amp;#${c.codePointAt(0)};`).replaceAll("\n", "<br>")}</div>`;
    const module = successful(
      await request("module", "composer/saveModule", {
        noteID: autosaveId,
        noteType: "email",
        type: "text",
        column: 1,
        data: { html },
      }),
    );
    const moduleId = id(module.itemID);
    done();
    const section = successful(
      await request("section", "composer/saveSection", {
        noteID: autosaveId,
        layout: 1,
        size: "normal",
        spacing: 0,
      }),
    );
    const sectionId = id(section.sectionID);
    done();
    successful(
      await request("layout", "composer/saveLayout", {
        noteID: autosaveId,
        sections: [{ sectionID: sectionId, modules: [moduleId] }],
      }),
    );
    done();
    const explicit = {
      ...payload,
      newNote: false,
      autosaveID: autosaveId,
      autosaved: 0,
      explicitSaveClick: true,
      schedule: {},
    };
    const materialized = record(
      successful(await request("materialize", "composer/save2", explicit)).note,
    );
    const noteId = id(materialized.ID);
    this.#progress = { ...this.#progress, noteId };
    if (noteId === autosaveId || id(materialized.autosaveID) !== autosaveId)
      return invalidResponse("note_identity_mismatch");
    done();
    const final = record(
      successful(
        await request("metadata", "composer/save2", {
          ...explicit,
          ID: noteId,
          status: "draft",
        }),
      ).note,
    );
    if (id(final.ID) !== noteId || id(final.autosaveID) !== autosaveId)
      return invalidResponse("note_identity_mismatch");
    done();
    this.#progress = { ...this.#progress, stage: "verify" };
    context.check();
    const verified = record(
      successful(
        await context.query(
          "composer/editNote",
          form({ noteID: noteId, fromComposer: 1 }),
        ),
      ).noteInfo,
    );
    context.check();
    const options = record(verified.options);
    if (
      id(verified.ID) !== noteId ||
      verified.type !== "email" ||
      verified.status !== "draft" ||
      verified.title !== input.subject ||
      verified.fromName !== fromName ||
      verified.themeID !== note.themeID ||
      options.schedule !== false ||
      options.route2 !== false ||
      options.voiceCalls !== false
    )
      return invalidResponse("draft_verification");
    target(verified.noteTargets, groupId);
    if (!Array.isArray(verified.sections) || verified.sections.length !== 1)
      return invalidResponse("draft_verification");
    const layout = record(verified.sections[0]);
    const first = record(layout.col1);
    if (
      !Array.isArray(first.items) ||
      first.items.length !== 1 ||
      (layout.col2 != null &&
        (!Array.isArray(record(layout.col2).items) ||
          (record(layout.col2).items as unknown[]).length))
    )
      return invalidResponse("draft_verification");
    const item = record(first.items[0]);
    if (
      item.type !== "text" ||
      persistedText(record(item.data).html) !== input.body
    )
      return invalidResponse("draft_verification");
    done();
    return { noteId, autosaveId, groupId, status: "draft", verified: true };
  }
}
