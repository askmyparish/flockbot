import { z } from "zod";
import { parse, type DefaultTreeAdapterMap } from "parse5";

export const payloadSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("captured"),
    json: z.string().max(8192),
    format: z.literal("html").optional(),
    truncated: z.boolean().optional(),
  }),
  z.object({
    state: z.literal("omitted"),
    reason: z.enum(["authentication", "unsupported", "unavailable", "limit"]),
  }),
]);
export type DiagnosticPayload = z.infer<typeof payloadSchema>;

// Headers and authentication exchanges never enter this sanitizer. Other JSON
// may contain credential-bearing fields or embedded credential representations.
const credentialWord =
  /auth|cookie|token|secret|passw|sess(?:ion|id)|csrf|xsrf|credential|bearer|otp|jwt|signature|nonce|apikey|accesskey|privatekey|pass(?:code|phrase)|pincode|(?:access|security|verification|reset|login|mfa|sms|onetime|twofactor)code|(?:pass|license|signing|client|recovery)key|userpin|pinnumber/i;
const shortCredentialWord =
  /(?:^|[^a-z])(?:sid|pwd|pass|sig|code|key|pin|header)(?:$|[^a-z])/i;
function credentialLabel(value: string): boolean {
  return (
    credentialWord.test(value) ||
    shortCredentialWord.test(value.replace(/([a-z])([A-Z])/g, "$1 $2"))
  );
}
function credentialKey(value: string): boolean {
  return credentialLabel(value) || /code|key|pin|header/i.test(value);
}
const REDACTED = "[redacted]";
const LIMIT = new Error();

function decodedText(input: string): string {
  let decoded = input;
  for (let i = 0; i <= 3; i++) {
    // Detection ignores invisible formatting; safe output retains the original.
    decoded = decoded
      .normalize("NFKC")
      .replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, "");
    if (i === 3 || !/%[\da-f]{2}/i.test(decoded)) break;
    decoded = decodeURIComponent(decoded);
  }
  // Unhandled encodings are not treated as safe plaintext.
  if (/%[\da-f]{2}|\\[ux][\da-f]|&(?:#\w+|[a-z]+);/i.test(decoded))
    throw new Error();
  return decoded;
}

function credentialValue(input: unknown, depth: number): boolean {
  // Follow label wrappers, not arbitrary response envelopes or prose fields.
  for (; depth <= 12; depth++) {
    if (typeof input === "string") return credentialLabel(decodedText(input));
    if (
      !input ||
      typeof input !== "object" ||
      (!Array.isArray(input) &&
        ![Object.prototype, null].includes(Object.getPrototypeOf(input)))
    )
      return false;
    const entries = Object.entries(input);
    if (entries.length !== 1) return false;
    const [key, child] = entries[0]!;
    if (
      !Array.isArray(input) &&
      !/^(v|value|label|name)$/i.test(decodedText(key))
    )
      return false;
    input = child;
  }
  return false;
}

/** Capture structured data only. Never truncate raw input before filtering it. */
function captureJson(value: unknown): DiagnosticPayload {
  let nodes = 0;
  function clean(input: unknown, depth: number): unknown {
    if (++nodes > 1000 || depth > 12) throw LIMIT;
    if (input === null || typeof input === "boolean") return input;
    if (typeof input === "number") {
      if (!Number.isFinite(input)) throw new Error();
      return input;
    }
    if (typeof input === "string") {
      if (input.length > 8192) throw LIMIT;
      const decoded = decodedText(input);
      if (
        credentialLabel(decoded) ||
        /basic\s|-----BEGIN|eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.|<\/?[a-z!]|[A-Za-z0-9+/_-]{32,}={0,2}/i.test(
          decoded,
        )
      )
        return REDACTED;
      if (/^\s*[[{]/.test(decoded)) {
        try {
          return JSON.stringify(clean(JSON.parse(decoded), depth + 1));
        } catch {
          return REDACTED;
        }
      }
      return input;
    }
    if (Array.isArray(input)) {
      if (input.some((entry) => credentialValue(entry, depth + 1)))
        return REDACTED;
      return input.map((entry) => clean(entry, depth + 1));
    }
    if (
      typeof input !== "object" ||
      !input ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(input))
    )
      throw new Error();
    const result: Record<string, unknown> = Object.create(null);
    for (const [key, child] of Object.entries(input)) {
      const label = decodedText(key);
      // Refuse unbounded or credential-bearing dynamic property names too.
      if (key.length > 128 || /[<>&=:]/.test(label)) throw new Error();
      // Label/value containers can use credential-named labels (key, header)
      // or wrapped labels, including form arrays; redact the whole container.
      if (
        credentialValue(child, depth + 1) ||
        (Array.isArray(child) &&
          child.some(
            (entry) =>
              typeof entry === "string" && credentialValue(entry, depth + 2),
          ))
      )
        return REDACTED;
      result[key] = credentialKey(label) ? REDACTED : clean(child, depth + 1);
    }
    return result;
  }
  try {
    const json = JSON.stringify(clean(value, 0));
    return Buffer.byteLength(json) <= 8192
      ? { state: "captured", json }
      : { state: "omitted", reason: "limit" };
  } catch (error) {
    return {
      state: "omitted",
      reason: error === LIMIT ? "limit" : "unsupported",
    };
  }
}

function captureForm(body: string | undefined): DiagnosticPayload {
  if (body === undefined) return { state: "omitted", reason: "unavailable" };
  if (Buffer.byteLength(body) > 8192)
    return { state: "omitted", reason: "limit" };
  const value: Record<string, string[]> = Object.create(null);
  for (const [key, entry] of new URLSearchParams(body)) {
    if (["__proto__", "constructor", "prototype"].includes(key))
      return { state: "omitted", reason: "unsupported" };
    value[key] ??= [];
    value[key].push(entry);
  }
  return captureJson(value);
}

const htmlTags = [
  "other",
  "html",
  "body",
  "main",
  "section",
  "article",
  "header",
  "footer",
  "nav",
  "div",
  "span",
  "p",
  "a",
  "ul",
  "ol",
  "li",
  "dl",
  "dt",
  "dd",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "th",
  "td",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "b",
  "strong",
  "i",
  "em",
  "small",
  "time",
  "br",
  "hr",
] as const;
const excludedHtmlTags = new Set([
  "script",
  "style",
  "template",
  "noscript",
  "iframe",
  "object",
  "embed",
  "svg",
  "math",
  "form",
  "input",
  "select",
  "textarea",
  "button",
  "option",
  "head",
  "title",
  "meta",
  "link",
  "base",
  "noembed",
  "noframes",
  "frame",
  "frameset",
  "datalist",
  "fieldset",
  "output",
  "meter",
  "progress",
]);
// Known page structure helps diagnose unexpected HTML responses. Preserve only
// these whole class tokens when other upstream classes redact.
const diagnosticClasses = new Set([
  "page_group",
  "page_notes",
  "note_list_item",
  "author",
  "load_more_notes",
]);
const htmlAttributes = z
  .object({
    class: z.string().max(1024).optional(),
    id: z.string().max(256).optional(),
    "data-date": z.string().max(256).optional(),
    "data-noteid": z.string().max(256).optional(),
    "data-groupid": z.string().max(256).optional(),
  })
  .strict();
const htmlElement = z
  .object({
    position: z.number().int().min(0).max(8192),
    depth: z.number().int().min(0).max(128),
    tag: z.enum(htmlTags),
    attributes: htmlAttributes,
    text: z
      .string()
      .max(1024 * 1024)
      .optional(),
  })
  .strict();
const htmlStructure = z
  .object({ elements: z.array(htmlElement).max(8192) })
  .strict();
type HtmlElement = z.infer<typeof htmlElement>;

function filteredText(value: string): string {
  const captured = captureJson(value);
  return captured.state === "captured" ? JSON.parse(captured.json) : REDACTED;
}

/** Reused for parsed HTML and for untrusted IPC/disk projections. */
function captureHtmlStructure(
  value: unknown,
  truncated = false,
): DiagnosticPayload {
  const parsed = htmlStructure.safeParse(value);
  if (!parsed.success) return { state: "omitted", reason: "unsupported" };
  const elements = parsed.data.elements;
  // HTML layout does not reliably associate credentials with their labels.
  // Retain only fixed diagnostic vocabulary and numeric schema attributes,
  // never arbitrary prose, DOM IDs or class tokens. JSON/forms keep their
  // existing credential filtering; all formats share this capture boundary.
  for (const element of elements) {
    for (const [key, value] of Object.entries(element.attributes)) {
      if (value === undefined) continue;
      let filtered = REDACTED;
      if (key === "class")
        filtered =
          value
            .split(/\s+/)
            .filter((token) => diagnosticClasses.has(token))
            .join(" ") || REDACTED;
      else if (key.startsWith("data-") && /^-?\d*(?:\.\d+)?$/.test(value))
        filtered = filteredText(value);
      Object.assign(element.attributes, { [key]: filtered });
    }
    const label = /^(Sent by|Draft|Scheduled)\b/.exec(
      element.text?.trim() ?? "",
    )?.[1];
    if (label) element.text = label;
    else delete element.text;
  }
  // Keep diagnostic attributes ahead of decorative wrappers when space is tight,
  // then restore document order. Position/depth expose gaps in the projection.
  const priority = (element: HtmlElement) =>
    Object.keys(element.attributes).some((key) => key.startsWith("data-"))
      ? 0
      : element.text
        ? 1
        : 2;
  elements.sort((a, b) => priority(a) - priority(b) || a.position - b.position);
  const retained: HtmlElement[] = [];
  let bytes = Buffer.byteLength('{"elements":[]}');
  for (const element of elements) {
    const size =
      Buffer.byteLength(JSON.stringify(element)) + (retained.length ? 1 : 0);
    if (bytes + size > 8192) {
      truncated = true;
      continue;
    }
    retained.push(element);
    bytes += size;
  }
  retained.sort((a, b) => a.position - b.position);
  return {
    state: "captured",
    format: "html",
    truncated,
    json: JSON.stringify({ elements: retained }),
  };
}

function captureHtml(value: string): DiagnosticPayload {
  if (Buffer.byteLength(value) > 1024 * 1024)
    return { state: "omitted", reason: "limit" };
  const elements: HtmlElement[] = [];
  const pending: { node: DefaultTreeAdapterMap["node"]; depth: number }[] = [
    { node: parse(value), depth: 0 },
  ];
  let position = 0;
  while (pending.length) {
    const next = pending.pop();
    if (!next) break;
    const { node, depth } = next;
    if (++position > 8192 || depth > 128)
      return { state: "omitted", reason: "limit" };
    if ("tagName" in node) {
      if (excludedHtmlTags.has(node.tagName)) continue;
      const attrs = Object.fromEntries(
        node.attrs.map(({ name, value }) => [name, value]),
      );
      if (
        Object.hasOwn(attrs, "hidden") ||
        (["dialog", "details"].includes(node.tagName) &&
          !Object.hasOwn(attrs, "open")) ||
        attrs["aria-hidden"]?.trim().toLowerCase() === "true" ||
        Object.hasOwn(attrs, "style") ||
        /(?:^|\s)(?:hidden|d-none)(?:\s|$)/i.test(attrs.class ?? "")
      )
        continue;
      const attributes: Record<string, string> = {};
      for (const key of Object.keys(htmlAttributes.shape)) {
        const attr = attrs[key];
        if (attr !== undefined) attributes[key] = attr;
      }
      elements.push({
        position,
        depth,
        // Unknown harmless wrappers keep their structure/text without exposing
        // arbitrary upstream tag names or discarding their descendants.
        tag: htmlTags.some((tag) => tag === node.tagName)
          ? (node.tagName as HtmlElement["tag"])
          : "other",
        attributes,
        text: node.childNodes
          .filter((child) => "value" in child)
          .map((child) => ("value" in child ? child.value : ""))
          .join(" ")
          .trim(),
      });
    }
    if ("childNodes" in node)
      for (const child of [...node.childNodes].reverse())
        if (!("value" in child))
          pending.push({ node: child, depth: depth + 1 });
  }
  return captureHtmlStructure({ elements });
}

/** One format dispatch and credential policy for every diagnostic caller. */
export function sanitizePayload(
  value: unknown,
  format: string,
): DiagnosticPayload {
  if (format === "json" && value !== undefined) return captureJson(value);
  if (format === "form" && (value === undefined || typeof value === "string"))
    return captureForm(value);
  if (format === "html" && typeof value === "string") {
    try {
      return captureHtml(value);
    } catch {
      return { state: "omitted", reason: "unsupported" };
    }
  }
  return { state: "omitted", reason: "unsupported" };
}

/** The disk and IPC boundaries use the same filtering as initial capture. */
export function safePayload(value: DiagnosticPayload): DiagnosticPayload {
  if (value.state === "omitted") return value;
  try {
    if (value.format === "html")
      return captureHtmlStructure(JSON.parse(value.json), value.truncated);
    return sanitizePayload(JSON.parse(value.json), "json");
  } catch {
    return { state: "omitted", reason: "unsupported" };
  }
}
