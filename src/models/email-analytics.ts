import { FlockbotError } from "../errors.js";
import { identifier } from "./identifier.js";
import {
  latestGroupEmail,
  type LatestEmailSelectionReason,
} from "./latest-group-email.js";
import { inputIdentifier } from "./member-fields.js";
import {
  membershipGroupSelector,
  type GroupSelector,
} from "./member-groups.js";
import type { Network } from "./network.js";
import { invalidResponse, record, successful, timestamp } from "./parsing.js";
import type { ResourceRead } from "./resource-read.js";

export interface EmailAnalyticsInput extends GroupSelector {
  readonly emailId?: string | undefined;
}

const countKeys = [
  "opened",
  "unopened",
  "bounced",
  "complaint",
  "sms",
  "total",
  "voicecalls",
  "clicks",
  "unsubscribes",
] as const;
export type EmailAnalyticsCounts = Readonly<
  Record<(typeof countKeys)[number], number | null>
>;
export interface EmailAnalyticsResult {
  readonly requested: EmailAnalyticsInput;
  readonly groupId: string | null;
  readonly selection: "selected" | "unknown";
  readonly email: {
    readonly id: string;
    readonly publishedDate: number;
  } | null;
  readonly counts: EmailAnalyticsCounts | null;
  readonly reason: "unsupported_email_type" | LatestEmailSelectionReason | null;
  readonly observedAt: string;
  readonly limitations: readonly string[];
}

/** Aggregate tracking facts only; never retains recipient or message content. */
export class EmailAnalytics {
  readonly #selector:
    | Readonly<{ emailId: string }>
    | ReturnType<typeof membershipGroupSelector>;

  constructor(input: EmailAnalyticsInput) {
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).some(
        (key) => !["emailId", "groupId", "groupName"].includes(key),
      ) ||
      [input.emailId, input.groupId, input.groupName].filter(
        (value) => value !== undefined,
      ).length !== 1
    )
      throw new FlockbotError("invalid_input");
    this.#selector =
      input.emailId === undefined
        ? membershipGroupSelector(input)
        : Object.freeze({ emailId: inputIdentifier(input.emailId) });
    Object.freeze(this);
  }

  async read(
    context: ResourceRead,
    network: Network,
  ): Promise<EmailAnalyticsResult> {
    context.check();
    let email: EmailAnalyticsResult["email"] = null;
    let groupId: string | null = null;
    let reason: EmailAnalyticsResult["reason"] = null;
    let summaryCounts: unknown;
    if ("emailId" in this.#selector) {
      const response = record(
        await context.read(
          `note/${this.#selector.emailId}/analyticsSummary?ajax`,
        ),
      );
      context.check();
      successful(response);
      const note = record(response.note);
      if (
        identifier(note.ID) !== this.#selector.emailId ||
        typeof note.type !== "string" ||
        !note.type.trim()
      )
        return invalidResponse("email_identity_shape");
      if (note.type === "email") {
        email = {
          id: this.#selector.emailId,
          publishedDate: timestamp(note.dateTime),
        };
        summaryCounts = response.counts;
      } else reason = "unsupported_email_type";
    } else {
      const selected = await latestGroupEmail(context, network, this.#selector);
      groupId = selected.groupId;
      email = selected.email;
      reason = selected.reason;
      if (selected.email !== null) summaryCounts = selected.summaryCounts;
    }
    let counts: EmailAnalyticsCounts | null = null;
    if (email !== null) {
      context.validationSource?.(`note/${email.id}/analyticsSummary?ajax`);
      const raw = record(summaryCounts);
      if (!countKeys.some((key) => Object.hasOwn(raw, key)))
        return invalidResponse("missing_analytics_counts");
      counts = Object.fromEntries(
        countKeys.map((key) => {
          const value = Object.hasOwn(raw, key) ? raw[key] : null;
          if (
            value !== null &&
            (typeof value !== "number" ||
              !Number.isSafeInteger(value) ||
              value < 0)
          )
            return invalidResponse("analytics_count_invalid");
          return [key, value];
        }),
      ) as EmailAnalyticsCounts;
    }
    context.check();
    return {
      requested: this.toInput(),
      groupId,
      selection: email ? "selected" : "unknown",
      email,
      counts,
      reason,
      observedAt: new Date().toISOString(),
      limitations: [
        "Counts are Flocknote's reported note-level categories, not a partition of unique recipients; total is not a verified recipient count.",
        "Tracking does not establish delivery or human reading. Counts are not attributed to an individual original send or resend attempt.",
        "Missing or null categories are unknown, not zero. No rates or derived totals are provided.",
        "publishedDate preserves Flocknote's raw publication timestamp; observedAt is the lookup time.",
        ...(groupId === null
          ? []
          : [
              "Latest means newest original send visible to this login, not latest resend. Unsupported mixed feeds are not searched. Separate reads are not an atomic snapshot.",
            ]),
      ],
    };
  }

  toInput(): EmailAnalyticsInput {
    return { ...this.#selector };
  }
  toJSON(): object {
    return { type: "EmailAnalytics", redacted: true };
  }
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return "EmailAnalytics { [REDACTED] }";
  }
}
