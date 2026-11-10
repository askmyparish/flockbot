import { identifier } from "./identifier.js";
import {
  latestGroupEmail,
  type LatestEmailSelectionReason,
} from "./latest-group-email.js";
import { MemberProfile } from "./member-profile.js";
import {
  membershipGroupSelector,
  type GroupSelector,
} from "./member-groups.js";
import type { Network } from "./network.js";
import { invalidResponse, record, successful } from "./parsing.js";
import type { ResourceQuery } from "./resource-read.js";

export interface MemberLatestEmailInput extends GroupSelector {
  readonly userId: string;
}

export type MemberEmailEngagement =
  | "recorded_open"
  | "reported_unopened"
  | "unknown";
export type MemberLatestEmailReason =
  | LatestEmailSelectionReason
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
    const selected = await latestGroupEmail(context, network, this.#selector);
    const userId = this.#profile.toInput().userId;
    const email = selected.email;
    const result = (
      reason: MemberLatestEmailReason | null,
      engagement: MemberEmailEngagement = "unknown",
    ): MemberLatestEmailResult => {
      context.check();
      return {
        userId,
        groupId: selected.groupId,
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
    if (email === null) return result(selected.reason);
    const profile = await this.#profile.read(context);
    context.check();
    // The captured successful query is a surname. Do not invent ID search or
    // silently fall back to a different query contract for short surnames.
    const term = profile.lastName.trim();
    if (term.length < 3) return result("unsupported_member_query");
    const response = successful(
      await context.query(
        `note/${email.id}/searchAnalytics?ajax`,
        new URLSearchParams({ s: term }).toString(),
      ),
    );
    context.check();
    if (response.s !== term) return invalidResponse("search_echo_mismatch");
    if (!Array.isArray(response.results))
      return invalidResponse("expected_results_array");
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
