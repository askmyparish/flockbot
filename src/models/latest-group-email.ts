import { identifier } from "./identifier.js";
import type { membershipGroupSelector } from "./member-groups.js";
import type { Network } from "./network.js";
import { invalidResponse, record, successful, timestamp } from "./parsing.js";
import type { ResourceRead } from "./resource-read.js";

export type LatestEmailSelectionReason =
  | "selection_unavailable"
  | "selection_ambiguous"
  | "unsupported_latest_note"
  | "inconsistent_email_metadata"
  | "unsupported_send_history";

type LatestGroupEmail = { readonly groupId: string } & (
  | { readonly email: null; readonly reason: LatestEmailSelectionReason }
  | {
      readonly email: { readonly id: string; readonly publishedDate: number };
      readonly reason: null;
      readonly summaryCounts: unknown;
    }
);

/** Internal selection only: raw counters must be parsed before public output. */
export async function latestGroupEmail(
  context: ResourceRead,
  network: Network,
  selector: ReturnType<typeof membershipGroupSelector>,
): Promise<LatestGroupEmail> {
  context.check();
  const group =
    "groupId" in selector
      ? { id: selector.groupId }
      : await network.findGroup(context, selector.groupName);
  const unknown = (reason: LatestEmailSelectionReason): LatestGroupEmail => {
    context.check();
    return { groupId: group.id, email: null, reason };
  };
  context.check();
  const response = await context.read(`group/${group.id}/notes?ajax&more`);
  context.check();
  const listing = record(response);
  if (identifier(listing.groupID) !== group.id)
    return invalidResponse("group_identity_mismatch");
  if (!Array.isArray(listing.notes))
    return invalidResponse("expected_notes_array");
  if (typeof listing.more !== "boolean")
    return invalidResponse("expected_pagination_boolean");
  const notes: { id: string; publishedDate: number }[] = [];
  const ids = new Set<string>();
  for (const value of listing.notes) {
    const row = record(value);
    const id = identifier(row.ID);
    if (ids.has(id)) return unknown("selection_ambiguous");
    ids.add(id);
    // This endpoint lists published notes. Do not skip unexpected rows to
    // manufacture a latest email from an unsupported response.
    if (row.status !== "published") return unknown("selection_ambiguous");
    const date = row.publishedDate;
    if (typeof date !== "number" || !Number.isSafeInteger(date) || date <= 0)
      return unknown("selection_ambiguous");
    notes.push({ id, publishedDate: date });
  }
  if (!notes.length) return unknown("selection_unavailable");
  const first = notes[0]!;
  if (
    notes.some(
      (note, i) => i > 0 && note.publishedDate > notes[i - 1]!.publishedDate,
    ) ||
    (notes[1] && first.publishedDate === notes[1].publishedDate) ||
    (notes.length === 1 && listing.more)
  )
    return unknown("selection_ambiguous");
  const summary = successful(
    await context.read(`note/${first.id}/analyticsSummary?ajax`),
  );
  context.check();
  const note = record(summary.note);
  if (
    identifier(note.ID) !== first.id ||
    timestamp(note.dateTime) !== first.publishedDate
  )
    return unknown("inconsistent_email_metadata");
  if (note.type !== "email") return unknown("unsupported_latest_note");
  if (!Array.isArray(note.noteTargets))
    return invalidResponse("note_targets_shape");
  if (
    !note.noteTargets.some((value) => {
      const target = record(value);
      return (
        target.groupID !== undefined && identifier(target.groupID) === group.id
      );
    })
  )
    return unknown("inconsistent_email_metadata");
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
    return unknown("inconsistent_email_metadata");
  if (!Array.isArray(analytics.sendingSummary))
    return invalidResponse("sending_summary_shape");
  if (
    analytics.sendingSummary.length !== 1 ||
    record(analytics.sendingSummary[0]).fromDate !== first.publishedDate
  )
    return unknown("unsupported_send_history");
  return {
    groupId: group.id,
    email: first,
    reason: null,
    summaryCounts: summary.counts,
  };
}
