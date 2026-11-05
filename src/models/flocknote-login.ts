import { FlockbotError } from "../errors.js";

/**
 * Sign-in identity parsed from the observed user/userData response contract.
 * Retains only the validated login ID and classifies known expiry/denial shapes.
 * The caller owns authentication requests, credentials and session state; parish
 * contact details belong to User and use their own resource contract.
 */
export class FlocknoteLogin {
  private constructor(readonly id: string) {
    Object.freeze(this);
  }

  static fromResponse(data: unknown): FlocknoteLogin {
    if (typeof data !== "object" || data === null || Array.isArray(data))
      throw new FlockbotError("authentication_protocol_error");
    const record = data as Record<string, unknown>;
    if (record.success !== true)
      throw new FlockbotError("authentication_protocol_error");
    if (record.authorized === false && record.userID === null)
      throw new FlockbotError("authentication_required");
    if (
      record.authorized === false &&
      typeof record.userID === "number" &&
      record.userID > 0
    )
      throw new FlockbotError("permission_denied");
    if (
      record.authorized === false ||
      typeof record.userID !== "number" ||
      !Number.isSafeInteger(record.userID) ||
      record.userID <= 0
    )
      throw new FlockbotError("authentication_protocol_error");
    return new FlocknoteLogin(String(record.userID));
  }
}
