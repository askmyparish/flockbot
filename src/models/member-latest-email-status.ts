import { parse, type DefaultTreeAdapterMap } from "parse5";
import { AuthenticationSuspectedError, FlockbotError } from "../errors.js";
import { identifier } from "./identifier.js";
import { MemberProfile } from "./member-profile.js";
import {
  membershipGroupSelector,
  type GroupSelector,
} from "./member-groups.js";
import type { Network } from "./network.js";
import { invalidResponse, record } from "./parsing.js";
import type { ResourceQuery } from "./resource-read.js";

export interface MemberLatestEmailInput extends GroupSelector {
  readonly userId: string;
}

export type MemberEmailEngagement =
  | "recorded_open"
  | "reported_unopened"
  | "unknown";
export type MemberLatestEmailReason =
  | "selection_unavailable"
  | "selection_ambiguous"
  | "unsupported_latest_note"
  | "inconsistent_email_metadata"
  | "unsupported_send_history"
  | "unsupported_member_query"
  | "member_not_in_search_results"
  | "ambiguous_member_status"
  | "unsupported_member_status";

export interface MemberLatestEmailResult {
  readonly userId: string;
  readonly groupId: string;
  readonly selection: "selected" | "unknown";
  readonly email: {
    readonly id: string;
    readonly publishedDate: number;
  } | null;
  readonly engagement: MemberEmailEngagement;
  readonly reason: MemberLatestEmailReason | null;
  readonly observedAt: string;
  readonly limitations: readonly string[];
}

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];

function elements(node: Node): Element[] {
  const result: Element[] = [];
  const pending = "childNodes" in node ? [...node.childNodes].reverse() : [];
  while (pending.length) {
    const child = pending.pop();
    if (!child || !("tagName" in child)) continue;
    if (["script", "style", "template"].includes(child.tagName)) continue;
    result.push(child);
    pending.push(...[...child.childNodes].reverse());
  }
  return result;
}

function attribute(node: Element, name: string): string | undefined {
  return node.attrs.find((attr) => attr.name === name)?.value;
}

function hasClass(node: Element, name: string): boolean {
  return (attribute(node, "class") ?? "").split(/\s+/).includes(name);
}

function content(node: Node): string {
  if ("value" in node) return node.value;
  if (
    "tagName" in node &&
    ["script", "style", "template"].includes(node.tagName)
  )
    return "";
  return "childNodes" in node ? node.childNodes.map(content).join("") : "";
}

function timestamp(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
    return invalidResponse();
  return value;
}

function successful(value: unknown): Record<string, unknown> {
  const response = record(value);
  if (response.success === false) throw new FlockbotError("upstream_rejected");
  if (response.success !== true) return invalidResponse();
  return response;
}

/** Bounded, identity-matched engagement lookup; never executes upstream HTML. */
export class MemberLatestEmailStatus {
  readonly #profile: MemberProfile;
  readonly #selector: ReturnType<typeof membershipGroupSelector>;

  constructor(input: MemberLatestEmailInput) {
    this.#profile = new MemberProfile(input.userId);
    this.#selector = membershipGroupSelector(input);
    Object.freeze(this);
  }

  async read(
    context: ResourceQuery,
    network: Network,
  ): Promise<MemberLatestEmailResult> {
    context.check();
    const group =
      "groupId" in this.#selector
        ? { id: this.#selector.groupId }
        : await network.findGroup(context, this.#selector.groupName);
    const userId = this.#profile.toInput().userId;
    let email: MemberLatestEmailResult["email"] = null;
    const result = (
      reason: MemberLatestEmailReason | null,
      engagement: MemberEmailEngagement = "unknown",
    ): MemberLatestEmailResult => {
      context.check();
      return {
        userId,
        groupId: group.id,
        selection: email === null ? "unknown" : "selected",
        email,
        engagement,
        reason,
        observedAt: new Date().toISOString(),
        limitations: [
          "Latest means newest original send visible to this login, not latest resend. Unsupported mixed feeds are not searched.",
          "A recorded open does not prove human reading; reported unopened does not prove unread. No delivery or non-recipient verdict is provided.",
          "Engagement is note-level, not attributed to an individual resend. Separate reads are not an atomic snapshot; missing search results are inconclusive.",
          "publishedDate preserves Flocknote's raw publication timestamp.",
        ],
      };
    };
    context.check();
    const html = await context.query(
      `group/${group.id}?ajax`,
      new URLSearchParams({
        preferredBoardUrl: "",
        preferredPanelType: "notes",
      }).toString(),
    );
    context.check();
    if (typeof html !== "string") return invalidResponse();
    const roots = elements(parse(html)).filter((node) =>
      hasClass(node, "page_group"),
    );
    if (roots.length !== 1)
      throw new AuthenticationSuspectedError("invalid_response");
    if (identifier(attribute(roots[0]!, "data-groupid")) !== group.id)
      return invalidResponse();
    const panels = elements(roots[0]!).filter((node) =>
      hasClass(node, "page_notes"),
    );
    if (panels.length !== 1) return result("selection_unavailable");
    const nodes = elements(panels[0]!);
    const items = nodes.filter((node) => hasClass(node, "note_list_item"));
    if (!items.length) return result("selection_unavailable");
    const notes = items.map((node) => {
      const date = attribute(node, "data-date");
      if (!date || !/^\d+$/.test(date)) return invalidResponse();
      return {
        id: identifier(attribute(node, "data-noteid")),
        publishedDate: timestamp(Number(date)),
      };
    });
    const first = notes[0]!;
    if (
      new Set(notes.map((note) => note.id)).size !== notes.length ||
      notes.some(
        (note, i) => i > 0 && note.publishedDate > notes[i - 1]!.publishedDate,
      ) ||
      (notes[1] && first.publishedDate === notes[1].publishedDate) ||
      (notes.length === 1 &&
        nodes.some((node) => hasClass(node, "load_more_notes")))
    )
      return result("selection_ambiguous");
    const authors = elements(items[0]!).filter((node) =>
      hasClass(node, "author"),
    );
    if (authors.length !== 1 || !/^Sent by\s/.test(content(authors[0]!).trim()))
      return result("unsupported_latest_note");
    const summary = successful(
      await context.read(`note/${first.id}/analyticsSummary?ajax`),
    );
    context.check();
    const note = record(summary.note);
    if (
      identifier(note.ID) !== first.id ||
      timestamp(note.dateTime) !== first.publishedDate
    )
      return result("inconsistent_email_metadata");
    if (note.type !== "email") return result("unsupported_latest_note");
    if (!Array.isArray(note.noteTargets)) return invalidResponse();
    if (
      !note.noteTargets.some((value) => {
        const target = record(value);
        return (
          target.groupID !== undefined &&
          identifier(target.groupID) === group.id
        );
      })
    )
      return result("inconsistent_email_metadata");
    const analytics = successful(
      await context.read(`note/${first.id}/analytics2?ajax`),
    );
    context.check();
    const metadata = record(analytics.note);
    if (
      identifier(metadata.ID) !== first.id ||
      metadata.type !== "email" ||
      timestamp(metadata.dateTime) !== first.publishedDate
    )
      return result("inconsistent_email_metadata");
    if (!Array.isArray(analytics.sendingSummary)) return invalidResponse();
    if (
      analytics.sendingSummary.length !== 1 ||
      record(analytics.sendingSummary[0]).fromDate !== first.publishedDate
    )
      return result("unsupported_send_history");
    email = first;
    const profile = await this.#profile.read(context);
    context.check();
    // The captured successful query is a surname. Do not invent ID search or
    // silently fall back to a different query contract for short surnames.
    const term = profile.lastName.trim();
    if (term.length < 3) return result("unsupported_member_query");
    const response = successful(
      await context.query(
        `note/${first.id}/searchAnalytics?ajax`,
        new URLSearchParams({ s: term }).toString(),
      ),
    );
    context.check();
    if (response.s !== term || !Array.isArray(response.results))
      return invalidResponse();
    const matches = response.results
      .map((value) => {
        const row = record(value);
        return { row, id: identifier(row.userid) };
      })
      .filter(({ id }) => id === userId);
    if (!matches.length) return result("member_not_in_search_results");
    if (matches.length !== 1) return result("ambiguous_member_status");
    const row = matches[0]!.row;
    if (
      row.targetContacts !== undefined &&
      (!Array.isArray(row.targetContacts) || row.targetContacts.length > 0)
    )
      return result("unsupported_member_status");
    if (row.status === "opened") return result(null, "recorded_open");
    if (row.status === "unopened") return result(null, "reported_unopened");
    return result("unsupported_member_status");
  }

  toInput(): MemberLatestEmailInput {
    return { userId: this.#profile.toInput().userId, ...this.#selector };
  }
  toJSON(): object {
    return { type: "MemberLatestEmailStatus", redacted: true };
  }
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return "MemberLatestEmailStatus { [REDACTED] }";
  }
}
