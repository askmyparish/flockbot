import type { MemberField } from "./member-fields.js";
import {
  MemberGroups,
  membershipGroupSelector,
  type GroupSelector,
  type CommunicationPreference,
  type MembershipCheckResult,
} from "./member-groups.js";
import { MemberProfile } from "./member-profile.js";
import type { Network } from "./network.js";
import type { ResourceQuery } from "./resource-read.js";

export interface MemberCommunicationInput extends GroupSelector {
  readonly userId: string;
  readonly fields?: readonly MemberField[] | undefined;
}

export type MemberCommunicationWarning =
  | "email_preference_disabled"
  | "sms_preference_disabled"
  | "email_contact_missing"
  | "sms_contact_missing"
  | "email_contact_unverified"
  | "sms_contact_unverified"
  | "email_flagged_bad"
  | "sms_stop_reported";

export interface MemberCommunicationChannel {
  readonly preference: CommunicationPreference;
  readonly contactPresent: boolean | null;
  readonly verified: boolean | null;
  /** Present only when selected and the stored field is available. */
  readonly value?: string | null;
}

export interface MemberCommunicationResult extends MembershipCheckResult {
  readonly email: MemberCommunicationChannel & {
    readonly isBadEmail: boolean | null;
  };
  readonly sms: MemberCommunicationChannel & {
    readonly stopReplied: boolean | null;
  };
  readonly warnings: readonly MemberCommunicationWarning[];
  readonly limitations: readonly string[];
}

/** One member/group diagnostic intent, with opt-in contact disclosure. */
export class MemberCommunicationStatus {
  readonly #profile: MemberProfile;
  readonly #groups: MemberGroups;
  readonly #selector: GroupSelector;

  constructor(input: MemberCommunicationInput) {
    this.#profile = new MemberProfile(input.userId, input.fields);
    this.#groups = new MemberGroups(input.userId);
    this.#selector = membershipGroupSelector(input);
    Object.freeze(this);
  }

  async read(
    context: ResourceQuery,
    network: Network,
  ): Promise<MemberCommunicationResult> {
    const { emailPreference, smsPreference, ...membership } =
      await this.#groups.communication(context, network, this.#selector);
    const contacts = await this.#profile.communication(context);
    context.check();
    const email = { preference: emailPreference, ...contacts.email };
    const sms = { preference: smsPreference, ...contacts.sms };
    const warnings: MemberCommunicationWarning[] = [];
    for (const [channel, facts] of [
      ["email", email],
      ["sms", sms],
    ] as const) {
      if (facts.preference === "disabled")
        warnings.push(`${channel}_preference_disabled`);
      if (facts.contactPresent === false)
        warnings.push(`${channel}_contact_missing`);
      if (facts.verified === false)
        warnings.push(`${channel}_contact_unverified`);
    }
    if (email.isBadEmail === true) warnings.push("email_flagged_bad");
    if (sms.stopReplied === true) warnings.push("sms_stop_reported");
    return {
      ...membership,
      email,
      sms,
      warnings,
      limitations: [
        "Suppressions are not assessed; settings do not establish delivery.",
        "Group visibility may be incomplete. Separate reads are not an atomic snapshot.",
      ],
    };
  }

  toInput(): MemberCommunicationInput {
    return { ...this.#profile.toInput(), ...this.#selector };
  }
  toJSON(): object {
    return { type: "MemberCommunicationStatus", redacted: true };
  }
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return "MemberCommunicationStatus { [REDACTED] }";
  }
}
