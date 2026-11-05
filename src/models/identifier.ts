import { invalidResponse as invalid, text } from "./parsing.js";
/** Decimal strings stay strings; never round an upstream identifier via Number. */
export function identifier(value: unknown): string {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value <= 0) return invalid();
    return String(value);
  }
  const id = text(value);
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) return invalid();
  if (/^\d+$/.test(id)) {
    const normalized = id.replace(/^0+/, "");
    return normalized || invalid();
  }
  return id;
}
