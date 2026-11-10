import { parse, type DefaultTreeAdapterMap } from "parse5";
import { invalidResponse as invalid, record, text } from "./parsing.js";
import { identifier } from "./identifier.js";
import type { GroupAttributes } from "./group.js";
type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
function group(
  id: unknown,
  name: unknown,
  shortName: unknown,
): GroupAttributes {
  const short = text(shortName);
  return {
    id: identifier(id),
    name: text(name),
    shortName: short,
    isEveryone: short.toLowerCase() === "everyone",
  };
}
function children(node: Node): Node[] {
  return "childNodes" in node ? node.childNodes : [];
}
function elements(node: Node): Element[] {
  const result: Element[] = [];
  for (const child of children(node)) {
    if ("tagName" in child) {
      if (["script", "style", "template"].includes(child.tagName)) continue;
      result.push(child);
    }
    result.push(...elements(child));
  }
  return result;
}
function attr(node: Element, name: string): string | undefined {
  return node.attrs.find((attribute) => attribute.name === name)?.value;
}
function hasClass(node: Element, name: string): boolean {
  return (attr(node, "class") ?? "").split(/\s+/).includes(name);
}
function content(node: Node): string {
  if ("value" in node) return node.value;
  if (
    "tagName" in node &&
    ["script", "style", "template"].includes(node.tagName)
  )
    return "";
  return children(node).map(content).join("");
}

/** null means the observed modern application shell, not an empty group list. */
export function dashboardGroups(value: unknown): GroupAttributes[] | null {
  if (typeof value !== "string") return invalid("expected_text");
  const nodes = elements(parse(value));
  const items = nodes.filter((node) => hasClass(node, "group_item"));
  const groups: GroupAttributes[] = [];
  for (const item of items) {
    const names = elements(item).filter((node) => hasClass(node, "group_name"));
    const shortName = attr(item, "data-shortname");
    // Recorded legacy pages also use this class for non-group structure.
    // A partially populated group is still a protocol error.
    if (shortName === undefined && names.length === 0) continue;
    groups.push(
      group(attr(item, "data-groupid"), names.map(content).join(""), shortName),
    );
  }
  if (groups.length) return deduplicate(groups);
  if (nodes.some((node) => attr(node, "id") === "fnReactHolder")) return null;
  return invalid("dashboard_shape");
}

export function navigationGroups(
  navigation: unknown,
  metadata: unknown,
  validationSource?: (path: string) => void,
): GroupAttributes[] {
  validationSource?.("navigation/groups");
  const list = record(navigation).groups;
  if (!Array.isArray(list)) return invalid("navigation_groups_shape");
  const groups = list.map((value: unknown) => {
    const item = record(value);
    return group(item.ID, item.name, item.shortname);
  });
  validationSource?.("network/getMetadata");
  const everyoneID = record(metadata).everyoneGroupID;
  // Explicit null is the supported no-Everyone representation. Absence is a
  // protocol error. This empty shape is simulated, not live-verified.
  if (everyoneID === null) return deduplicate(groups);
  const everyone = group(everyoneID, "Everyone", "everyone");
  return deduplicate([
    everyone,
    ...groups.filter((item) => item.id !== everyone.id && !item.isEveryone),
  ]);
}

function deduplicate(groups: GroupAttributes[]): GroupAttributes[] {
  const ids = new Set<string>();
  let hasEveryone = false;
  return groups.filter((item) => {
    if (ids.has(item.id) || (item.isEveryone && hasEveryone)) return false;
    ids.add(item.id);
    if (item.isEveryone) hasEveryone = true;
    return true;
  });
}
