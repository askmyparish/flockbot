import { parseFragment, type DefaultTreeAdapterMap } from "parse5";
import { FlockbotError } from "../errors.js";
import type { FailureReason } from "../failure-reason.js";

/** The composer decodes named entities; escaped numeric references survive it. */
export function encodeDraftText(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&amp;#${c.codePointAt(0)};`);
}

/** Shared authoring-link policy for HTML links and native URL buttons. */
export function safeDraftUrl(value: string): boolean {
  if (!/^https?:\/\//i.test(value) || /[\s\\\p{Cc}\p{Cs}]/u.test(value))
    return false;
  try {
    const url = new URL(value);
    return Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** Authoring policy, not a lossy sanitizer. Persisted content uses the same grammar. */
export function htmlDraftBody(value: string, persisted = false) {
  // The composer trims outer HTML whitespace, but retains interior runs and tabs.
  if (!persisted) value = value.replace(/^[\t\n\r ]+|[\t\n\r ]+$/g, "");
  const fail = (reason: FailureReason): never => {
    throw new FlockbotError(
      persisted ? "invalid_response" : "invalid_input",
      undefined,
      persisted ? undefined : "not_submitted",
      undefined,
      persisted ? "draft_verification" : reason,
    );
  };
  const root = parseFragment(value, {
    sourceCodeLocationInfo: true,
    onParseError: () => fail("draft_html_malformed"),
  });
  let visible = false;
  function children(
    nodes: DefaultTreeAdapterMap["childNode"][],
    start: number,
    end: number,
    parent?: string,
    phrasingOnly = false,
  ): { html: string; signature: string } {
    const list = parent === "ul" || parent === "ol";
    let html = "",
      signature = "",
      offset = start;
    for (const node of nodes) {
      const location = node.sourceCodeLocation;
      // Reject ignored tokens, inserted elements, omitted end tags and reparenting.
      if (
        !location ||
        location.startOffset !== offset ||
        location.endOffset > end
      )
        return fail("draft_html_malformed");
      offset = location.endOffset;
      if (node.nodeName === "#text" && "value" in node) {
        if (list && /[^\t\n\r ]/.test(node.value))
          return fail("draft_html_unsupported");
        const content = persisted
          ? node.value
          : node.value.replaceAll("\n", " ");
        if (content.replace(/\p{Cf}/gu, "").trim()) visible = true;
        html += encodeDraftText(content);
        signature += JSON.stringify(["text", content]);
        continue;
      }
      if (
        !("tagName" in node) ||
        ![
          "p",
          "div",
          "br",
          "h1",
          "h2",
          "h3",
          "h4",
          "h5",
          "h6",
          "strong",
          "b",
          "em",
          "i",
          "ul",
          "ol",
          "li",
          "blockquote",
          "a",
        ].includes(node.tagName)
      )
        return fail("draft_html_unsupported");
      const tag = node.tagName;
      const inline = ["strong", "b", "em", "i", "a", "br"].includes(tag);
      if (
        (list && tag !== "li") ||
        (tag === "li" && !list) ||
        (phrasingOnly && !inline)
      )
        return fail("draft_html_unsupported");
      const loc = node.sourceCodeLocation;
      if (!loc?.startTag || (tag !== "br" && !loc.endTag))
        return fail("draft_html_malformed");
      let href: string | undefined;
      if (tag === "a") {
        if (node.attrs.length !== 1 || node.attrs[0]?.name !== "href")
          return fail("draft_html_unsupported");
        href = node.attrs[0].value;
        if (!safeDraftUrl(href)) return fail("draft_html_unsafe_link");
      } else if (node.attrs.length) return fail("draft_html_unsupported");
      const inner =
        tag === "br"
          ? { html: "", signature: "" }
          : children(
              node.childNodes,
              loc.startTag.endOffset,
              loc.endTag!.startOffset,
              tag,
              // Links have a transparent content model: inherit their context.
              phrasingOnly ||
                (inline && tag !== "a") ||
                tag === "p" ||
                /^h[1-6]$/.test(tag),
            );
      html += `<${tag}${href === undefined ? "" : ` href="${encodeDraftText(href)}"`}>${inner.html}${tag === "br" ? "" : `</${tag}>`}`;
      // Flocknote stores authored paragraphs as div blocks; no CSS margins promised.
      signature +=
        JSON.stringify([
          "element",
          !persisted && tag === "p" ? "div" : tag,
          href ?? null,
        ]) +
        inner.signature +
        '["end"]';
    }
    if (offset !== end) return fail("draft_html_malformed");
    return { html, signature };
  }
  const result = children(root.childNodes, 0, value.length);
  if (!visible) return fail("draft_html_empty");
  return result;
}
