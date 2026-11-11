import { FlockbotError } from "../errors.js";
import { identifier } from "./identifier.js";
import {
  membershipGroupSelector,
  type GroupSelector,
} from "./member-groups.js";
import type { Network } from "./network.js";
import { invalidResponse, record } from "./parsing.js";
import type { ResourceRead } from "./resource-read.js";

export interface GroupNoteSummary {
  readonly id: string;
  readonly title: string | null;
  readonly titleTruncated: boolean;
  readonly publishedDate: number | null;
  /** Only published is observed on this listing; other accepted labels are provisional. */
  readonly status: "published" | "draft" | "scheduled" | "autosaved" | null;
  readonly type: null;
}

export interface GroupNotesResult {
  readonly requested: GroupSelector;
  readonly groupId: string;
  readonly notes: readonly GroupNoteSummary[];
  readonly upstreamReturnedCount: number;
  readonly returnedCount: number;
  readonly hasMore: boolean;
  readonly truncated: boolean;
  readonly observedAt: string;
  readonly limitations: readonly string[];
}

/** A single visible page, not the stricter latest-original-email selection. */
export class GroupNotes {
  readonly #selector: ReturnType<typeof membershipGroupSelector>;

  constructor(input: GroupSelector) {
    this.#selector = membershipGroupSelector(input);
    if (
      Object.keys(input).some((key) => !["groupId", "groupName"].includes(key))
    )
      throw new FlockbotError("invalid_input");
    Object.freeze(this);
  }

  async list(
    context: ResourceRead,
    network: Network,
  ): Promise<GroupNotesResult> {
    context.check();
    const group =
      "groupId" in this.#selector
        ? { id: this.#selector.groupId }
        : await network.findGroup(context, this.#selector.groupName);
    context.check();
    const response = await context.read(`group/${group.id}/notes?ajax&more`);
    context.check();
    const data = record(response);
    if (identifier(data.groupID) !== group.id)
      return invalidResponse("group_identity_mismatch");
    if (!Array.isArray(data.notes))
      return invalidResponse("expected_notes_array");
    if (typeof data.more !== "boolean")
      return invalidResponse("expected_pagination_boolean");
    const ids = new Set<string>();
    const notes: GroupNoteSummary[] = [];
    // Validate every identity, including rows outside the output cap.
    for (const value of data.notes) {
      const row = record(value);
      const id = identifier(row.ID);
      if (id.length > 128) return invalidResponse("identifier_too_long");
      if (ids.has(id)) return invalidResponse("duplicate_identifier");
      ids.add(id);
      if (notes.length === 50) continue;
      const title =
        typeof row.title === "string" && !/\p{Cc}/u.test(row.title)
          ? row.title.trim() || null
          : null;
      notes.push({
        id,
        title: title?.slice(0, 512) ?? null,
        titleTruncated: title !== null && title.length > 512,
        publishedDate:
          typeof row.publishedDate === "number" &&
          Number.isSafeInteger(row.publishedDate) &&
          row.publishedDate > 0
            ? row.publishedDate
            : null,
        status:
          row.status === "published" ||
          row.status === "draft" ||
          row.status === "scheduled" ||
          row.status === "autosaved"
            ? row.status
            : null,
        // The observed group listing does not establish a channel field.
        type: null,
      });
    }
    context.check();
    return {
      requested: this.toInput(),
      groupId: group.id,
      notes,
      upstreamReturnedCount: data.notes.length,
      returnedCount: notes.length,
      hasMore: data.more,
      truncated:
        data.notes.length > notes.length || notes.some((m) => m.titleTruncated),
      observedAt: new Date().toISOString(),
      limitations: [
        "One page visible to this login, in upstream order; not an exhaustive note archive or proof of original-send chronology.",
        "hasMore is the upstream continuation flag; truncated reports local clipping of rows or titles. No continuation was requested.",
        "type is unknown for this listing. Publication status does not establish sending or delivery; publishedDate preserves the raw upstream value without a timezone conversion.",
      ],
    };
  }

  toInput(): GroupSelector {
    return { ...this.#selector };
  }
  toJSON(): object {
    return { type: "GroupNotes", redacted: true };
  }
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return "GroupNotes { [REDACTED] }";
  }
}
