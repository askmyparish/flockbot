import { FlockbotError } from "../errors.js";
import { identifier } from "./identifier.js";
import { inputIdentifier, memberName, storedContact } from "./member-fields.js";
import { invalidResponse, record, successful } from "./parsing.js";
import type { ResourceQuery } from "./resource-read.js";

export interface EmailRecipientsInput {
  readonly emailId: string;
  readonly category: "opened" | "unopened";
  readonly fields?: readonly "address"[] | undefined;
}

export interface EmailRecipient {
  readonly userId: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly nameTruncated: boolean;
  readonly address?: string | null;
  readonly addressTruncated?: boolean;
}

export interface EmailRecipientsResult {
  readonly requested: EmailRecipientsInput;
  readonly selection: "selected" | "unknown";
  readonly reason: "unsupported_email_type" | null;
  readonly page: 1;
  readonly recipients: readonly EmailRecipient[];
  readonly totalRecords: number | null;
  readonly upstreamReturnedCount: number;
  readonly returnedCount: number;
  readonly omittedCount: number;
  readonly hasMore: null;
  readonly truncated: boolean;
  readonly completeness: "unknown";
  readonly observedAt: string;
  readonly limitations: readonly string[];
}

/** One category page of reported email contacts, not verified human readers. */
export class EmailRecipients {
  readonly #input: EmailRecipientsInput;

  constructor(input: EmailRecipientsInput) {
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).some(
        (key) => !["emailId", "category", "fields"].includes(key),
      ) ||
      !["opened", "unopened"].includes(input.category) ||
      (input.fields !== undefined &&
        (!Array.isArray(input.fields) ||
          input.fields.length > 1 ||
          input.fields.some((field) => field !== "address")))
    )
      throw new FlockbotError("invalid_input");
    this.#input = Object.freeze({
      emailId: inputIdentifier(input.emailId),
      category: input.category,
      fields: Object.freeze([...(input.fields ?? [])]),
    });
    Object.freeze(this);
  }

  async read(context: ResourceQuery): Promise<EmailRecipientsResult> {
    context.check();
    const summary = successful(
      await context.read(`note/${this.#input.emailId}/analyticsSummary?ajax`),
    );
    context.check();
    const note = record(summary.note);
    if (
      identifier(note.ID) !== this.#input.emailId ||
      typeof note.type !== "string" ||
      !note.type.trim()
    )
      return invalidResponse("email_identity_shape");
    const supported = note.type === "email";
    const recipients: EmailRecipient[] = [];
    let totalRecords: number | null = null;
    let upstreamReturnedCount = 0;
    let omittedCount = 0;
    let truncated = false;
    if (supported) {
      const data = successful(
        await context.query(
          `note/${this.#input.emailId}/detailedAnalytics?ajax`,
          new URLSearchParams({
            type: this.#input.category,
            page: "1",
          }).toString(),
        ),
      );
      context.check();
      if (data.type !== this.#input.category || data.page !== "1")
        return invalidResponse("recipient_page_mismatch");
      if (!Array.isArray(data.records))
        return invalidResponse("expected_results_array");
      if (
        typeof data.totalRecords !== "number" ||
        !Number.isSafeInteger(data.totalRecords) ||
        data.totalRecords < 0
      )
        return invalidResponse("invalid_result_count");
      totalRecords = data.totalRecords;
      upstreamReturnedCount = data.records.length;
      truncated = upstreamReturnedCount > 50;
      // Bound projection to the first 50 upstream rows, not 50 successfully parsed people.
      for (const value of data.records.slice(0, 50)) {
        const row = record(value);
        // Only mailgun contacts with no delegated targets are established by evidence.
        if (
          row.service !== "mailgun" ||
          !Array.isArray(row.targetContacts) ||
          row.targetContacts.length !== 0
        ) {
          omittedCount++;
          continue;
        }
        let userId: string;
        try {
          userId = identifier(row.userID);
        } catch (error) {
          if (!(error instanceof FlockbotError)) throw error;
          omittedCount++;
          continue;
        }
        if (userId.length > 128) {
          omittedCount++;
          continue;
        }
        const firstName = memberName(row.fname);
        const lastName = memberName(row.lname);
        const nameTruncated = firstName.length > 256 || lastName.length > 256;
        // Validate supported records independently of which fields are projected.
        const contact = storedContact(row.address);
        const address = this.#input.fields?.includes("address")
          ? contact
          : undefined;
        const addressTruncated =
          address !== undefined && address !== null && address.length > 320;
        recipients.push({
          userId,
          firstName: firstName.slice(0, 256),
          lastName: lastName.slice(0, 256),
          nameTruncated,
          ...(address === undefined
            ? {}
            : { address: address?.slice(0, 320) ?? null, addressTruncated }),
        });
        truncated ||= nameTruncated || addressTruncated;
      }
    }
    context.check();
    return {
      requested: this.toInput(),
      selection: supported ? "selected" : "unknown",
      reason: supported ? null : "unsupported_email_type",
      page: 1,
      recipients,
      totalRecords,
      upstreamReturnedCount,
      returnedCount: recipients.length,
      omittedCount,
      hasMore: null,
      truncated,
      completeness: "unknown",
      observedAt: new Date().toISOString(),
      limitations: [
        "One page of Flocknote category records visible to this login; not a complete list or a count of unique people. Repeated member IDs are preserved.",
        "Recorded opens do not prove human reading or delivery; unopened does not prove unread. Records are not attributed to a particular resend.",
        "totalRecords is the upstream-reported value, not a verified archive total. hasMore and completeness are unknown; further pages are unsupported.",
        "omittedCount counts unsupported rows within the first 50; truncated reports local row or text clipping. No profile or contact enrichment is performed.",
        "Only mailgun records with empty targetContacts are supported. Separate summary and category reads are not an atomic snapshot.",
      ],
    };
  }

  toInput(): EmailRecipientsInput {
    return { ...this.#input, fields: [...(this.#input.fields ?? [])] };
  }
  toJSON(): object {
    return { type: "EmailRecipients", redacted: true };
  }
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return "EmailRecipients { [REDACTED] }";
  }
}
