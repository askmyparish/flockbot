import { parseFragment, type DefaultTreeAdapterMap } from "parse5";
import { FlockbotError, type DraftProgress } from "../errors.js";
import { identifier } from "./identifier.js";
import { composerForm as form } from "./composer-form.js";
import {
  membershipGroupSelector,
  type GroupSelector,
} from "./member-groups.js";
import type { Network } from "./network.js";
import { invalidResponse, record, successful } from "./parsing.js";
import type { ResourceQuery } from "./resource-read.js";
import {
  encodeDraftText,
  htmlDraftBody,
  safeDraftUrl,
} from "./email-draft-html.js";

export type EmailDraftBlock =
  | {
      readonly type: "text";
      readonly body: string;
      readonly bodyFormat?: "text" | "html" | undefined;
    }
  | { readonly type: "image"; readonly path: string }
  | { readonly type: "button"; readonly text: string; readonly url: string };

export interface EmailDraftInput extends GroupSelector {
  readonly subject: string;
  readonly body?: string | undefined;
  readonly bodyFormat?: "text" | "html" | undefined;
  readonly content?: readonly EmailDraftBlock[] | undefined;
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
  uploadImage?(path: string): Promise<unknown>;
}

const buttonStyle = {
  fontFamily: "Arial",
  fontSize: "16",
  maxWidth: "300",
  padding: "12",
  backgroundColor: "336699",
  textColor: "ffffff",
};

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
  readonly #modules: {
    type: "text" | "button" | "photo";
    data: Record<string, string>;
    path?: string | undefined;
    signature?: string | undefined;
    plainText?: string | undefined;
  }[];
  #progress: DraftProgress = { stage: "resolve_group", completedStages: [] };
  #submitted = false;
  constructor(input: EmailDraftInput) {
    let normalized: EmailDraftBlock[];
    try {
      if (
        !input ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        Object.keys(input).some(
          (k) =>
            ![
              "groupId",
              "groupName",
              "subject",
              "body",
              "bodyFormat",
              "content",
            ].includes(k),
        ) ||
        typeof input.subject !== "string" ||
        !input.subject.trim() ||
        /[\p{Cc}\p{Cs}]/u.test(input.subject)
      )
        throw new Error();
      const ordered = input.content !== undefined;
      if (ordered && ("body" in input || "bodyFormat" in input))
        throw new Error();
      const blocks: unknown = ordered
        ? input.content
        : [{ type: "text", body: input.body, bodyFormat: input.bodyFormat }];
      if (!Array.isArray(blocks) || !blocks.length) throw new Error();
      normalized = Array.from(blocks, (value: unknown): EmailDraftBlock => {
        if (!value || typeof value !== "object" || Array.isArray(value))
          throw new Error();
        const block = value as Record<string, unknown>;
        if (block.type === "image") {
          if (
            Object.keys(block).some((k) => !["type", "path"].includes(k)) ||
            typeof block.path !== "string" ||
            !block.path.trim() ||
            /[\p{Cc}\p{Cs}]/u.test(block.path)
          )
            throw new Error();
          return Object.freeze({ type: "image", path: block.path });
        }
        if (block.type === "button") {
          if (
            Object.keys(block).some(
              (k) => !["type", "text", "url"].includes(k),
            ) ||
            typeof block.text !== "string" ||
            !block.text.replace(/\p{Cf}/gu, "").trim() ||
            /[\r\n\u2028\u2029\p{Cc}\p{Cs}]/u.test(block.text) ||
            typeof block.url !== "string" ||
            !safeDraftUrl(block.url)
          )
            throw new Error();
          return Object.freeze({
            type: "button",
            text: block.text,
            url: block.url,
          });
        }
        if (
          block.type !== "text" ||
          Object.keys(block).some(
            (k) => !["type", "body", "bodyFormat"].includes(k),
          ) ||
          typeof block.body !== "string" ||
          !block.body.trim() ||
          (block.bodyFormat !== undefined &&
            block.bodyFormat !== "text" &&
            block.bodyFormat !== "html")
        )
          throw new Error();
        const body = block.body.replace(/\r\n?/g, "\n");
        if (
          /\p{Cs}/u.test(body) ||
          (block.bodyFormat !== "html" &&
            /\p{Cc}/u.test(body.replace(/[\n\t]/g, "")))
        )
          throw new Error();
        return Object.freeze({
          type: "text",
          body,
          ...(block.bodyFormat === undefined
            ? {}
            : { bodyFormat: block.bodyFormat }),
        });
      });
      const first = normalized[0];
      this.#input = Object.freeze({
        ...membershipGroupSelector(input),
        subject: input.subject.trim(),
        ...(!ordered && first?.type === "text"
          ? {
              body: first.body,
              ...(first.bodyFormat === undefined
                ? {}
                : { bodyFormat: first.bodyFormat }),
            }
          : { content: Object.freeze(normalized) }),
      });
    } catch {
      throw new FlockbotError("invalid_input", undefined, "not_submitted");
    }
    this.#modules = normalized.map((block) => {
      if (block.type === "image")
        return { type: "photo", path: block.path, data: {} };
      if (block.type === "button")
        return {
          type: "button",
          data: {
            type: "url",
            text: block.text,
            url: block.url,
            ...buttonStyle,
          },
        };
      const html =
        block.bodyFormat === "html" ? htmlDraftBody(block.body) : undefined;
      return {
        type: "text",
        data: {
          html:
            html?.html ??
            `<div>${encodeDraftText(block.body).replaceAll("\n", "<br>")}</div>`,
        },
        signature: html?.signature,
        plainText: block.body,
      };
    });
  }
  toInput(): EmailDraftInput {
    return {
      ...this.#input,
      ...(this.#input.content
        ? { content: this.#input.content.map((block) => ({ ...block })) }
        : {}),
    };
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
      ...(this.#progress.photoIds
        ? { photoIds: [...this.#progress.photoIds] }
        : {}),
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
    if (
      this.#modules.some((module) => module.type === "photo") &&
      !context.uploadImage
    )
      throw new FlockbotError("invalid_configuration");
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
      fromName: "",
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
    const moduleIds: string[] = [];
    for (const block of this.#modules) {
      if (block.type === "photo") {
        this.#progress = { ...this.#progress, stage: "upload" };
        context.check();
        this.#submitted = true;
        const uploaded = successful(await context.uploadImage!(block.path!));
        const photoId = id(uploaded.photoID);
        this.#progress = {
          ...this.#progress,
          photoIds: [...(this.#progress.photoIds ?? []), photoId],
        };
        if (typeof uploaded.url !== "string" || !safeDraftUrl(uploaded.url))
          return invalidResponse("draft_image_upload");
        block.data.photoID = photoId;
      }
      const module = successful(
        await request("module", "composer/saveModule", {
          noteID: autosaveId,
          noteType: "email",
          column: 1,
          type: block.type,
          data: block.data,
        }),
      );
      const moduleId = id(module.itemID);
      if (moduleIds.includes(moduleId))
        return invalidResponse("duplicate_identifier");
      moduleIds.push(moduleId);
    }
    if (this.#progress.photoIds?.length)
      this.#progress = {
        ...this.#progress,
        completedStages: [...this.#progress.completedStages, "upload"],
      };
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
        sections: [{ sectionID: sectionId, modules: moduleIds }],
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
      verified.fromName !== "" ||
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
      first.items.length !== this.#modules.length ||
      (layout.col2 != null &&
        (!Array.isArray(record(layout.col2).items) ||
          (record(layout.col2).items as unknown[]).length))
    )
      return invalidResponse("draft_verification");
    for (const [index, expected] of this.#modules.entries()) {
      const item = record(first.items[index]);
      const data = record(item.data);
      if (item.type !== expected.type || id(data.ID) !== moduleIds[index])
        return invalidResponse("draft_verification");
      if (expected.type === "photo") {
        const dimensions = record(data.photodimensions);
        if (
          id(data.photoID) !== expected.data.photoID ||
          typeof data.photourl !== "string" ||
          !safeDraftUrl(data.photourl) ||
          !Number.isSafeInteger(dimensions.width) ||
          Number(dimensions.width) <= 0 ||
          !Number.isSafeInteger(dimensions.height) ||
          Number(dimensions.height) <= 0 ||
          Object.keys(data).some(
            (key) =>
              ![
                "photoID",
                "ID",
                "noteID",
                "networkID",
                "noteType",
                "photodimensions",
                "photourl",
              ].includes(key),
          )
        )
          return invalidResponse("draft_verification");
      } else if (expected.type === "button") {
        if (
          Object.entries(expected.data).some(
            ([key, value]) => data[key] !== value,
          ) ||
          Object.keys(data).some(
            (key) =>
              ![
                ...Object.keys(expected.data),
                "ID",
                "noteID",
                "networkID",
                "noteType",
              ].includes(key),
          )
        )
          return invalidResponse("draft_verification");
      } else if (
        typeof data.html !== "string" ||
        (expected.signature !== undefined
          ? htmlDraftBody(data.html, true).signature !== expected.signature
          : persistedText(data.html) !== expected.plainText)
      )
        return invalidResponse("draft_verification");
    }
    done();
    return { noteId, autosaveId, groupId, status: "draft", verified: true };
  }
}
