import { FlockbotError } from "../errors.js";
import { identifier } from "./identifier.js";
import { invalidResponse, record, successful } from "./parsing.js";
import type { ResourceQuery } from "./resource-read.js";

export interface NoteSearchInput {
  readonly searchTerm: string;
}
export interface NoteSearchSummary {
  readonly id: string;
  readonly title: string | null;
  readonly titleTruncated: boolean;
  readonly date: number | null;
  readonly type: "email" | "sms" | "scheduled" | null;
  readonly groupTargets:
    | readonly {
        groupId: string;
        name: string | null;
        nameTruncated: boolean;
      }[]
    | null;
  readonly groupTargetsTruncated: boolean;
}
export interface NoteSearchResult {
  readonly notes: readonly NoteSearchSummary[];
  readonly totalHits: number;
  readonly upstreamReturnedCount: number;
  readonly returnedCount: number;
  readonly omittedNonNoteCount: number;
  readonly clippedNoteCount: number;
  readonly completeness: "partial" | "unknown";
  readonly truncated: boolean;
  readonly observedAt: string;
  readonly limitations: readonly string[];
}

const filters = ["note", "event", "file", "user", "group", "comment"];

function optionalText(value: unknown): string | null {
  return typeof value === "string" && !/\p{Cc}/u.test(value)
    ? value.trim() || null
    : null;
}

function groupTargets(
  value: unknown,
): Pick<NoteSearchSummary, "groupTargets" | "groupTargetsTruncated"> {
  const unknown = { groupTargets: null, groupTargetsTruncated: false };
  if (!Array.isArray(value)) return unknown;
  const targets: NonNullable<NoteSearchSummary["groupTargets"]>[number][] = [];
  let clipped = false;
  for (const item of value) {
    if (typeof item !== "object" || item === null || Array.isArray(item))
      return unknown;
    if (item.type !== "group" || item.groupID === undefined) continue;
    let groupId: string;
    try {
      groupId = identifier(item.groupID);
    } catch {
      return unknown;
    }
    if (groupId.length > 128) return unknown;
    if (targets.length === 10) {
      clipped = true;
      continue;
    }
    const name = optionalText(item.name);
    const nameTruncated = name !== null && name.length > 256;
    targets.push({ groupId, name: name?.slice(0, 256) ?? null, nameTruncated });
  }
  return { groupTargets: targets, groupTargetsTruncated: clipped };
}

/** One broad parish query, projecting only note summaries from its mixed results. */
export class NoteSearch {
  readonly #term: string;
  constructor(input: NoteSearchInput) {
    if (
      typeof input !== "object" ||
      input === null ||
      Array.isArray(input) ||
      Object.keys(input).some((key) => key !== "searchTerm") ||
      typeof input.searchTerm !== "string" ||
      !input.searchTerm.trim() ||
      input.searchTerm.length > 256 ||
      /\p{Cc}/u.test(input.searchTerm)
    )
      throw new FlockbotError("invalid_input");
    this.#term = input.searchTerm.trim();
    Object.freeze(this);
  }

  async find(context: ResourceQuery): Promise<NoteSearchResult> {
    context.check();
    const metadata = await context.query("network/getMetadata");
    context.check();
    const networkId = identifier(successful(metadata).networkID);
    if (networkId.length > 128) return invalidResponse("identifier_too_long");
    const body = new URLSearchParams({
      searchTerm: this.#term,
      networkID: networkId,
    });
    for (const filter of filters) body.append("filters[]", filter);
    const response = await context.query(
      "supersearch/query?ajax",
      body.toString(),
    );
    context.check();
    const data = successful(response);
    if (data.searchTerm !== this.#term)
      return invalidResponse("search_echo_mismatch");
    const echoed = record(data.searchFilters);
    if (
      filters.some((key) => echoed[key] !== true) ||
      (echoed.userDocument !== undefined &&
        typeof echoed.userDocument !== "boolean")
    )
      return invalidResponse("search_filter_shape");
    if (!Array.isArray(data.searchResults))
      return invalidResponse("expected_results_array");
    if (
      typeof data.totalHits !== "number" ||
      !Number.isSafeInteger(data.totalHits) ||
      data.totalHits < data.searchResults.length
    )
      return invalidResponse("invalid_result_count");
    const notes: NoteSearchSummary[] = [];
    const ids = new Set<string>();
    let omittedNonNoteCount = 0;
    let clippedNoteCount = 0;
    for (const value of data.searchResults) {
      const row = record(value);
      if (row.entityType !== "note") {
        omittedNonNoteCount++;
        continue;
      }
      const id = identifier(row.noteID);
      if (id.length > 128) return invalidResponse("identifier_too_long");
      if (row.entityID !== undefined && identifier(row.entityID) !== id)
        return invalidResponse("note_identity_mismatch");
      if (ids.has(id)) return invalidResponse("duplicate_identifier");
      ids.add(id);
      if (notes.length === 50) {
        clippedNoteCount++;
        continue;
      }
      const title = optionalText(row.noteTitle);
      notes.push({
        id,
        title: title?.slice(0, 512) ?? null,
        titleTruncated: title !== null && title.length > 512,
        date:
          typeof row.date === "number" &&
          Number.isSafeInteger(row.date) &&
          row.date > 0
            ? row.date
            : null,
        type:
          row.type === "email" || row.type === "sms" || row.type === "scheduled"
            ? row.type
            : null,
        ...groupTargets(row.noteTargets),
      });
    }
    context.check();
    return {
      notes,
      totalHits: data.totalHits,
      upstreamReturnedCount: data.searchResults.length,
      returnedCount: notes.length,
      omittedNonNoteCount,
      clippedNoteCount,
      completeness:
        data.totalHits > data.searchResults.length || clippedNoteCount > 0
          ? "partial"
          : "unknown",
      truncated:
        clippedNoteCount > 0 ||
        notes.some(
          (m) =>
            m.titleTruncated ||
            m.groupTargetsTruncated ||
            m.groupTargets?.some((target) => target.nameTruncated),
        ),
      observedAt: new Date().toISOString(),
      limitations: [
        "One visible search page in upstream order, not chronological or an exhaustive note archive. An empty note result does not establish absence.",
        "totalHits covers all requested entity kinds, not only notes. partial means more broad hits or locally clipped notes; equality does not prove completeness.",
        "type preserves recognized search labels, not delivery status; scheduled does not establish sending. date is raw upstream evidence, not a proven original-send timestamp.",
        "Only targets with type group and an explicit groupID are included. Missing or malformed optional target metadata is unknown, not proof of no recipients. No recipient identities or bodies are returned.",
      ],
    };
  }

  toInput(): NoteSearchInput {
    return { searchTerm: this.#term };
  }
  toJSON(): object {
    return { type: "NoteSearch", redacted: true };
  }
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return "NoteSearch { [REDACTED] }";
  }
}
