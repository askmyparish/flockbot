/** Selected upstream facts only; they never establish whether a write applied. */
export interface UpstreamResponse {
  readonly success?: boolean;
  readonly authorized?: boolean;
  readonly error?: string;
  readonly errorTruncated?: true;
  readonly userId?: string;
  readonly existingSubscription?: boolean;
}

/** Keep actual wording and contact values; remove credentials and log controls. */
export function responseText(
  value: string,
  secrets: readonly string[] = [],
): string {
  let text = value;
  for (const secret of [...secrets]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length))
    text = text.split(secret).join("[redacted]");
  if (
    /\b(?:password|passwd|passcode|secret|token|cookie|authorization|bearer|session(?:id|data|key)?|verification.?code|one.?time.?code)\b/i.test(
      text,
    )
  )
    return "[credential-related response withheld]";
  return text
    .replace(/<[^>]*>/g, " ")
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Copy only the known response fields, without retaining a body or headers. */
export function upstreamResponse(
  value: unknown,
  secrets: readonly string[] = [],
): UpstreamResponse | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  const source = value as Record<string, unknown>;
  const result: {
    success?: boolean;
    authorized?: boolean;
    error?: string;
    errorTruncated?: true;
    userId?: string;
    existingSubscription?: boolean;
  } = {};
  if (typeof source.success === "boolean") result.success = source.success;
  if (typeof source.authorized === "boolean")
    result.authorized = source.authorized;
  if (typeof source.existingSubscription === "boolean")
    result.existingSubscription = source.existingSubscription;
  const message =
    typeof source.error === "string" && source.error.trim()
      ? source.error
      : source.message;
  if (typeof message === "string") {
    const text = responseText(message, secrets);
    if (text) result.error = text.slice(0, 1024);
    if (text.length > 1024 || source.errorTruncated === true)
      result.errorTruncated = true;
  }
  const id = source.userID ?? source.userId;
  if (typeof id === "number" && Number.isSafeInteger(id) && id > 0)
    result.userId = String(id);
  if (typeof id === "string" && /^[0-9]{1,40}$/.test(id) && !/^0+$/.test(id))
    result.userId = id;
  return Object.keys(result).length ? Object.freeze(result) : undefined;
}
