import { parse, type DefaultTreeAdapterMap } from "parse5";
import { FlockbotError, type OperationOptions } from "./index.js";

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
export interface GroupAttributes {
  readonly id: string;
  readonly name: string;
  readonly shortName: string;
  readonly isEveryone: boolean;
}
export interface SubscriberCountOptions extends OperationOptions {
  readonly force?: boolean;
}

/** Obtained from client.groups(); its count cache lives only on this object. */
export class Group implements GroupAttributes {
  readonly id: string;
  readonly name: string;
  readonly shortName: string;
  readonly isEveryone: boolean;
  readonly #readCount: (options: OperationOptions) => Promise<number>;
  #count: number | undefined;

  constructor(
    attributes: GroupAttributes,
    readCount: (options: OperationOptions) => Promise<number>,
  ) {
    this.id = attributes.id;
    this.name = attributes.name;
    this.shortName = attributes.shortName;
    this.isEveryone = attributes.isEveryone;
    this.#readCount = readCount;
    Object.freeze(this);
  }

  async subscriberCount(options: SubscriberCountOptions = {}): Promise<number> {
    if (options.signal?.aborted) throw new FlockbotError("operation_cancelled");
    if (this.#count !== undefined && !options.force) return this.#count;
    const count = await this.#readCount(options);
    this.#count = count;
    return count;
  }
}

function invalid(): never {
  throw new FlockbotError("invalid_response");
}
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return invalid();
  return value.trim();
}
/** Decimal strings stay strings; never round an upstream identifier via Number. */
function identifier(value: unknown): string {
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
  if (typeof value !== "string") return invalid();
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
  return invalid();
}

export function navigationGroups(
  navigation: unknown,
  metadata: unknown,
): GroupAttributes[] {
  const list = record(navigation).groups;
  if (!Array.isArray(list)) return invalid();
  const groups = list.map((value: unknown) => {
    const item = record(value);
    return group(item.ID, item.name, item.shortname);
  });
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

export function subscriberCount(value: unknown): number {
  const count = record(value).subscriberCount;
  if (typeof count === "number") {
    if (Number.isSafeInteger(count) && count >= 0) return count;
    return invalid();
  }
  if (typeof count !== "string" || !/^\d+$/.test(count.trim()))
    return invalid();
  const parsed = Number(count.trim());
  if (!Number.isSafeInteger(parsed)) return invalid();
  return parsed;
}
