import { FlockbotError } from "../errors.js";
export interface UserInput {
  readonly firstName: string;
  readonly lastName: string;
  readonly email?: string | null | undefined;
  readonly mobilePhone?: string | null | undefined;
}

function invalid(): never {
  throw new FlockbotError("invalid_input", undefined, "not_submitted");
}

function field(value: unknown, optional = false): string {
  if (optional && (value === undefined || value === null)) return "";
  if (typeof value !== "string") return invalid();
  const trimmed = value.trim();
  if (/\p{Cc}/u.test(trimmed) || (!optional && !trimmed)) return invalid();
  return trimmed;
}

/**
 * Validated contact details used when requesting a group membership addition.
 * Snapshots caller input before asynchronous work and redacts default inspection
 * and JSON output. An upstream user ID is established by a separate API contract;
 * constructing this contact snapshot performs no network request.
 */
export class User {
  readonly #firstName: string;
  readonly #lastName: string;
  readonly #email: string;
  readonly #mobilePhone: string;
  get firstName(): string {
    return this.#firstName;
  }
  get lastName(): string {
    return this.#lastName;
  }
  get email(): string {
    return this.#email;
  }
  get mobilePhone(): string {
    return this.#mobilePhone;
  }
  constructor(input: UserInput) {
    try {
      if (typeof input !== "object" || input === null || Array.isArray(input))
        invalid();
      const fname = field(input.firstName);
      const lname = field(input.lastName);
      const email = field(input.email, true);
      const mobile = field(input.mobilePhone, true);
      if (!email && !mobile) invalid();
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) invalid();
      if (
        mobile &&
        (!/^\+?[\d(). -]+$/.test(mobile) ||
          mobile.replace(/\D/g, "").length < 7 ||
          mobile.replace(/\D/g, "").length > 15)
      )
        invalid();
      this.#firstName = fname;
      this.#lastName = lname;
      this.#email = email;
      this.#mobilePhone = mobile;
    } catch {
      throw new FlockbotError("invalid_input", undefined, "not_submitted");
    }
    Object.freeze(this);
  }
  toJSON(): object {
    return { type: "User", redacted: true };
  }
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return "User { [REDACTED] }";
  }
}
