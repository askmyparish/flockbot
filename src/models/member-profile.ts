import { FlockbotError } from "../errors.js";
import { identifier } from "./identifier.js";
import {
  type ContactValue,
  type MemberField,
  inputIdentifier,
  memberFields,
  memberName,
  storedContact,
} from "./member-fields.js";
import { invalidResponse, record } from "./parsing.js";
import type { ResourceQuery } from "./resource-read.js";

export interface MemberEmail extends ContactValue {
  readonly isBadEmail: boolean;
}
export interface MemberProfileResult {
  readonly id: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly email?: MemberEmail;
  readonly mobilePhone?: ContactValue;
  /** Selected fields omitted by the upstream profile, distinct from explicit null. */
  readonly unavailableFields?: readonly MemberField[];
}

function profileFlag(value: unknown): boolean {
  if (typeof value !== "boolean") return invalidResponse("expected_boolean");
  return value;
}

function optionalFlag(
  info: Record<string, unknown>,
  key: string,
): boolean | null {
  return Object.hasOwn(info, key) ? profileFlag(info[key]) : null;
}

/** An identified profile-read intent. Only explicitly selected contacts are exposed. */
export class MemberProfile {
  readonly #userId: string;
  readonly #fields: readonly MemberField[];

  constructor(userId: string, fields?: readonly MemberField[]) {
    this.#userId = inputIdentifier(userId);
    this.#fields = memberFields(fields);
    Object.freeze(this);
  }

  async #info(context: ResourceQuery): Promise<Record<string, unknown>> {
    context.check();
    const data = record(await context.query(`user/${this.#userId}/profile`));
    context.check();
    if (data.success !== true)
      throw new FlockbotError(
        "upstream_rejected",
        undefined,
        undefined,
        undefined,
        data.success === false ? "success_false" : "expected_success",
      );
    if (data.isInCurrentNet === false || data.canViewProfile === false)
      throw new FlockbotError("permission_denied");
    if (!profileFlag(data.isInCurrentNet) || !profileFlag(data.canViewProfile))
      return invalidResponse("profile_access_shape");
    const info = record(data.userInfo);
    if (info.canViewProfile === false)
      throw new FlockbotError("permission_denied");
    if (!profileFlag(info.canViewProfile))
      return invalidResponse("profile_access_shape");
    // The envelope userID is the viewer, not necessarily the selected person.
    if (identifier(info.userID) !== this.#userId)
      return invalidResponse("profile_identity_mismatch");
    const firstName = memberName(info.firstName);
    const lastName = memberName(info.lastName);
    if (!firstName && !lastName) return invalidResponse("missing_name");
    return info;
  }

  async read(context: ResourceQuery): Promise<MemberProfileResult> {
    const info = await this.#info(context);
    const unavailableFields = this.#fields.filter(
      (field) => !Object.hasOwn(info, field),
    );
    return {
      id: this.#userId,
      firstName: memberName(info.firstName),
      lastName: memberName(info.lastName),
      ...(this.#fields.includes("email") && Object.hasOwn(info, "email")
        ? {
            email: {
              value: storedContact(info.email),
              verified: profileFlag(info.emailVerified),
              isBadEmail: profileFlag(info.isBadEmail),
            },
          }
        : {}),
      ...(this.#fields.includes("mobilePhone") &&
      Object.hasOwn(info, "mobilePhone")
        ? {
            mobilePhone: {
              value: storedContact(info.mobilePhone),
              verified: profileFlag(info.mobilePhoneVerified),
            },
          }
        : {}),
      ...(unavailableFields.length ? { unavailableFields } : {}),
    };
  }

  async communication(context: ResourceQuery) {
    const info = await this.#info(context);
    const contact = (field: MemberField) => {
      const present = Object.hasOwn(info, field);
      const value = present ? storedContact(info[field]) : null;
      return {
        contactPresent: present ? value !== null : null,
        verified: optionalFlag(info, `${field}Verified`),
        ...(present && this.#fields.includes(field) ? { value } : {}),
      };
    };
    const stopReplied = Object.hasOwn(info, "stopReplyData")
      ? optionalFlag(record(info.stopReplyData), "isStopReplied")
      : null;
    return {
      email: {
        ...contact("email"),
        isBadEmail: optionalFlag(info, "isBadEmail"),
      },
      sms: { ...contact("mobilePhone"), stopReplied },
    };
  }

  /** Explicit transport projection; default inspection and JSON stay redacted. */
  toInput(): { userId: string; fields: MemberField[] } {
    return { userId: this.#userId, fields: [...this.#fields] };
  }
  toJSON(): object {
    return { type: "MemberProfile", redacted: true };
  }
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return "MemberProfile { [REDACTED] }";
  }
}
