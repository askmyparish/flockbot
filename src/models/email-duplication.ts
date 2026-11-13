import {
  AuthenticationSuspectedError,
  FlockbotError,
  type DraftProgress,
} from "../errors.js";
import { TRANSPORT_REASONS } from "../failure-reason.js";
import { composerForm } from "./composer-form.js";
import type { DraftContext } from "./email-draft.js";
import { safeDraftUrl } from "./email-draft-html.js";
import { identifier } from "./identifier.js";
import type { Network } from "./network.js";
import { invalidResponse, record, successful, text } from "./parsing.js";

export interface EmailDuplicationInput {
  readonly noteId: string;
}

function id(value: unknown): string {
  const result = identifier(value);
  if (!/^\d{1,128}$/.test(result))
    return invalidResponse("expected_identifier");
  return result;
}

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const left = Object.entries(a),
    right = Object.entries(b);
  return (
    left.length === right.length &&
    left.every(
      ([key, value]) =>
        Object.hasOwn(b, key) &&
        same(value, (b as Record<string, unknown>)[key]),
    )
  );
}

/** Validate ordinary audiences, and select only known metadata for the new draft. */
function targets(value: unknown) {
  if (!Array.isArray(value) || !value.length)
    return invalidResponse("duplicate_targets_unsupported");
  const seen = new Set<string>();
  return value
    .map((item) => {
      const row = record(item);
      const groupId = id(row.groupID);
      if (
        id(row.entityID) !== groupId ||
        seen.has(groupId) ||
        row.targetType !== "group" ||
        row.targetTypeDictID !== 1 ||
        row.isParent !== false ||
        row.includeContacts !== false ||
        row.isSmartGroup !== false ||
        row.isFilteredGroup !== false ||
        typeof row.isEveryoneGroup !== "boolean"
      )
        return invalidResponse("duplicate_targets_unsupported");
      seen.add(groupId);
      return {
        ID: null,
        entityID: groupId,
        groupID: groupId,
        targetType: "group",
        targetTypeDictID: 1,
        isParent: false,
        includeContacts: false,
        isSmartGroup: false,
        isFilteredGroup: false,
        isEveryoneGroup: row.isEveryoneGroup,
      };
    })
    .sort((a, b) => a.groupID.localeCompare(b.groupID));
}

/** Compare raw authored data; only observed native-copy identities are removed. */
function content(
  note: Record<string, unknown>,
  noteId: string,
  networkId: string,
  comparePhotos: boolean,
) {
  if (!Array.isArray(note.sections) || !note.sections.length)
    return invalidResponse("duplicate_content_unsupported");
  const sections = structuredClone(note.sections);
  const ids = new Set<string>();
  for (const value of sections) {
    const section = record(value);
    id(section.ID);
    delete section.ID;
    if (section.layout !== "1")
      return invalidResponse("duplicate_content_unsupported");
    for (const key of ["col1", "col2"]) {
      const column = record(section[key]);
      if (
        !Array.isArray(column.items) ||
        (key === "col2" && column.items.length)
      )
        return invalidResponse("duplicate_content_unsupported");
      for (const item of column.items) {
        const module = record(item),
          data = record(module.data);
        const moduleId = id(data.ID);
        if (
          ids.has(moduleId) ||
          id(data.noteID) !== noteId ||
          id(data.networkID) !== networkId
        )
          return invalidResponse("note_identity_mismatch");
        ids.add(moduleId);
        if (module.type === "text") {
          if (typeof data.html !== "string")
            return invalidResponse("duplicate_content_unsupported");
        } else if (module.type === "button") {
          if (
            data.type !== "url" ||
            typeof data.text !== "string" ||
            typeof data.url !== "string"
          )
            return invalidResponse("duplicate_content_unsupported");
        } else if (module.type === "photo") {
          id(data.photoID);
          const dimensions = record(data.photodimensions);
          if (
            typeof data.photourl !== "string" ||
            !safeDraftUrl(data.photourl) ||
            !Number.isSafeInteger(dimensions.width) ||
            Number(dimensions.width) <= 0 ||
            !Number.isSafeInteger(dimensions.height) ||
            Number(dimensions.height) <= 0
          )
            return invalidResponse("duplicate_content_unsupported");
          if (!comparePhotos) delete data.photoID;
        } else return invalidResponse("duplicate_content_unsupported");
        delete data.ID;
        delete data.noteID;
      }
    }
  }
  if (!ids.size) return invalidResponse("duplicate_content_unsupported");
  return sections;
}

function safeOptions(note: Record<string, unknown>) {
  const options = record(note.options);
  for (const key of ["comments", "includeLink", "includeGroupHeader"])
    if (typeof options[key] !== "boolean")
      return invalidResponse("duplicate_source_unsupported");
  if (record(options.replyToGive).enabled !== false)
    return invalidResponse("duplicate_source_unsupported");
  return {
    comments: options.comments,
    includeLink: options.includeLink,
    includeGroupHeader: options.includeGroupHeader,
    schedule: false,
    route2: false,
    voiceCalls: false,
    replyToGive: { enabled: false },
  };
}

function unscheduled(
  note: Record<string, unknown>,
  reason:
    | "duplicate_source_unsupported"
    | "duplicate_verification" = "duplicate_verification",
) {
  const options = record(note.options);
  if (
    options.schedule !== false ||
    options.route2 !== false ||
    options.voiceCalls !== false ||
    options.scheduleTime != null ||
    record(options.replyToGive).enabled !== false
  )
    return invalidResponse(reason);
}

/** One native copy intent. No source metadata or content is ever submitted for editing. */
export class EmailDuplication {
  readonly #noteId: string;
  #submitted = false;
  #progress: DraftProgress = { stage: "resolve_source", completedStages: [] };

  constructor(input: EmailDuplicationInput) {
    try {
      if (Object.keys(input).some((key) => key !== "noteId")) throw new Error();
      this.#noteId = id(input.noteId);
    } catch {
      throw new FlockbotError("invalid_input", undefined, "not_submitted");
    }
  }
  toInput(): EmailDuplicationInput {
    return { noteId: this.#noteId };
  }
  get submitted() {
    return this.#submitted;
  }
  get progress(): DraftProgress {
    return {
      ...this.#progress,
      completedStages: [...this.#progress.completedStages],
    };
  }

  async create(context: DraftContext, network: Network) {
    try {
      return await this.#create(context, network);
    } catch (error) {
      // Preserve the adapter's authentication diagnosis and transport failures.
      if (
        error instanceof AuthenticationSuspectedError ||
        !(error instanceof FlockbotError) ||
        error.code !== "invalid_response" ||
        (error.reason !== undefined && TRANSPORT_REASONS.has(error.reason)) ||
        (!this.#submitted &&
          error.reason !== "duplicate_source_unsupported" &&
          error.reason !== "duplicate_content_unsupported" &&
          error.reason !== "duplicate_targets_unsupported" &&
          error.reason !== "note_identity_mismatch")
      )
        throw error;
      throw new FlockbotError(
        this.#submitted ? "invalid_response" : "draft_not_submitted",
        error.status,
        this.#submitted ? "unknown" : "not_submitted",
        error.response,
        this.#submitted ? "duplicate_verification" : error.reason,
        this.progress,
      );
    }
  }

  async #create(context: DraftContext, network: Network) {
    const sourceId = this.#noteId;
    const read = async (noteId: string) => {
      context.check();
      const response = await context.query(
        "composer/editNote",
        composerForm({ noteID: noteId, fromComposer: 1 }),
      );
      context.check();
      return record(successful(response).noteInfo);
    };
    const source = await read(sourceId);
    if (id(source.ID) !== sourceId)
      return invalidResponse("note_identity_mismatch");
    if (
      source.type !== "email" ||
      source.status !== "published" ||
      source.newNote !== false ||
      source.duplicate !== false ||
      source.autosaveID != null
    )
      return invalidResponse("duplicate_source_unsupported");
    const networkId = id(source.networkID);
    context.check();
    if (
      id(successful(await context.read("network/getMetadata")).networkID) !==
      networkId
    )
      return invalidResponse("origin_mismatch");
    const originalTargets = targets(source.noteTargets);
    const groups = await network.discoverGroups(context);
    if (
      originalTargets.some(
        (target) =>
          !groups.some(
            (group) =>
              group.id === target.groupID &&
              group.isEveryone === target.isEveryoneGroup,
          ),
      )
    )
      return invalidResponse("duplicate_targets_unsupported");
    const originalContent = content(source, sourceId, networkId, false);
    text(source.title);
    if (typeof source.fromName !== "string")
      return invalidResponse("duplicate_source_unsupported");
    if (!Number.isSafeInteger(source.themeID) || Number(source.themeID) < 0)
      return invalidResponse("duplicate_source_unsupported");
    const options = safeOptions(source);
    unscheduled(source, "duplicate_source_unsupported");
    const done = () => {
      this.#progress = {
        ...this.#progress,
        completedStages: [
          ...this.#progress.completedStages,
          this.#progress.stage,
        ],
      };
    };
    const write = async (
      stage: DraftProgress["stage"],
      path: string,
      payload: Record<string, unknown>,
    ) => {
      this.#progress = { ...this.#progress, stage };
      context.check();
      this.#submitted = true;
      const response = await context.compose(path, composerForm(payload));
      return successful(response);
    };
    done();
    const duplicate = record(
      (
        await write("duplicate", "composer/duplicateNote", {
          groupID: "",
          noteID: sourceId,
          fromComposer: 1,
        })
      ).noteInfo,
    );
    const autosaveId = id(duplicate.autosaveID);
    this.#progress = { ...this.#progress, autosaveId };
    if (
      autosaveId === sourceId ||
      duplicate.ID !== 0 ||
      duplicate.duplicate !== true ||
      duplicate.type !== "email" ||
      duplicate.status !== "autosaved" ||
      id(duplicate.networkID) !== networkId ||
      duplicate.title !== source.title ||
      duplicate.fromName !== source.fromName ||
      duplicate.themeID !== source.themeID ||
      !Array.isArray(duplicate.noteTargets) ||
      duplicate.noteTargets.length
    )
      return invalidResponse("duplicate_verification");
    unscheduled(duplicate);
    if (
      !same(content(duplicate, autosaveId, networkId, false), originalContent)
    )
      return invalidResponse("duplicate_verification");
    const copiedContent = content(duplicate, autosaveId, networkId, true);
    done();
    const payload = {
      ID: 0,
      autosaveID: autosaveId,
      autosaved: 0,
      explicitSaveClick: true,
      newNote: false,
      duplicate: true,
      type: "email",
      status: "autosaved",
      title: source.title,
      fromName: "",
      themeID: source.themeID,
      networkID: networkId,
      userID: id(duplicate.userID),
      noteTargets: originalTargets,
      options,
      returnVoiceData: false,
      schedule: {},
    };
    const saved = record(
      (await write("materialize", "composer/save2", payload)).note,
    );
    const noteId = id(saved.ID);
    this.#progress = { ...this.#progress, noteId };
    if (
      noteId === sourceId ||
      noteId === autosaveId ||
      id(saved.autosaveID) !== autosaveId ||
      saved.status !== "draft"
    )
      return invalidResponse("note_identity_mismatch");
    done();
    // The native first save can omit fromName; set it on the final-ID save too.
    const final = record(
      (
        await write("metadata", "composer/save2", {
          ...payload,
          ID: noteId,
          status: "draft",
        })
      ).note,
    );
    if (id(final.ID) !== noteId || id(final.autosaveID) !== autosaveId)
      return invalidResponse("note_identity_mismatch");
    done();
    this.#progress = { ...this.#progress, stage: "verify" };
    const persisted = await read(noteId);
    if (
      id(persisted.ID) !== noteId ||
      id(persisted.networkID) !== networkId ||
      persisted.type !== "email" ||
      persisted.status !== "draft" ||
      persisted.newNote !== false ||
      persisted.duplicate !== false ||
      persisted.autosaveID != null ||
      persisted.title !== source.title ||
      persisted.fromName !== "" ||
      persisted.themeID !== source.themeID ||
      !same(targets(persisted.noteTargets), originalTargets) ||
      !same(safeOptions(persisted), options) ||
      !same(content(persisted, noteId, networkId, true), copiedContent)
    )
      return invalidResponse("duplicate_verification");
    unscheduled(persisted);
    done();
    return {
      sourceNoteId: sourceId,
      noteId,
      autosaveId,
      groupIds: originalTargets.map((target) => target.groupID),
      status: "draft" as const,
      verified: true as const,
    };
  }
}
