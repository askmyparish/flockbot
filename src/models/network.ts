import { AuthenticationSuspectedError, FlockbotError } from "../errors.js";
import type { GroupAttributes } from "./group.js";
import { dashboardGroups, navigationGroups } from "./group-discovery.js";
import type { ResourceRead } from "./resource-read.js";

/**
 * A parish network identified by its configured Flocknote origin.
 * Owns group discovery, case-insensitive unique-name resolution and an optional discovery cache.
 * Callers supply readers within their session, deadline and coordination boundary;
 * read scheduling and cache lifetime follow the adapter's configured policy.
 * Construction validates configuration without making a network request.
 */
export class Network {
  readonly origin: string;
  readonly subdomain: string;
  readonly #cacheMs: number;
  readonly #parallel: boolean;
  readonly #now: () => number;
  #groups: { expires: number; value: readonly GroupAttributes[] } | undefined;

  constructor(
    subdomain: string,
    options: {
      cacheMs?: number;
      parallelReads?: boolean;
      now?: () => number;
    } = {},
  ) {
    this.subdomain = normalizeSubdomain(subdomain);
    this.origin = `https://${this.subdomain}.flocknote.com`;
    this.#cacheMs = options.cacheMs ?? 0;
    if (!Number.isFinite(this.#cacheMs) || this.#cacheMs < 0)
      throw new FlockbotError("invalid_configuration");
    this.#parallel = options.parallelReads ?? false;
    this.#now = options.now ?? (() => performance.now());
  }

  clearGroups(): void {
    this.#groups = undefined;
  }

  async discoverGroups(
    context: ResourceRead,
    options: { refresh?: boolean } = {},
  ): Promise<readonly GroupAttributes[]> {
    context.check();
    if (!options.refresh && this.#groups && this.#groups.expires > this.#now())
      return this.#groups.value;
    const dashboard = await context.read("dashboard");
    context.check();
    let groups: GroupAttributes[] | null;
    try {
      groups = dashboardGroups(dashboard);
    } catch (error) {
      if (
        error instanceof FlockbotError &&
        error.code === "invalid_response" &&
        typeof dashboard === "string" &&
        dashboard.trimStart().startsWith("<")
      )
        throw new AuthenticationSuspectedError("invalid_response");
      throw error;
    }
    context.check();
    if (groups === null) {
      let navigation: unknown;
      let metadata: unknown;
      if (this.#parallel) {
        // Drain both reads before releasing the caller's coordination, including on failure.
        const [first, second] = await Promise.allSettled([
          context.read("navigation/groups"),
          context.read("network/getMetadata"),
        ]);
        context.check();
        if (first.status === "rejected") throw first.reason;
        if (second.status === "rejected") throw second.reason;
        navigation = first.value;
        metadata = second.value;
      } else {
        navigation = await context.read("navigation/groups");
        context.check();
        metadata = await context.read("network/getMetadata");
        context.check();
      }
      groups = navigationGroups(navigation, metadata);
    }
    context.check();
    const value = Object.freeze(
      groups.map((group) => Object.freeze({ ...group })),
    );
    if (this.#cacheMs > 0)
      this.#groups = { value, expires: this.#now() + this.#cacheMs };
    return value;
  }

  async findGroup(
    context: ResourceRead,
    name: string,
  ): Promise<GroupAttributes> {
    const selected = normalizedGroupName(name);
    const matches = (await this.discoverGroups(context)).filter(
      (group) => group.name.toLowerCase() === selected.toLowerCase(),
    );
    const match = matches[0];
    if (matches.length !== 1 || !match)
      throw new FlockbotError(
        matches.length ? "group_ambiguous" : "group_not_found",
      );
    return match;
  }
}

export function normalizeSubdomain(subdomain: string): string {
  if (
    typeof subdomain !== "string" ||
    subdomain.length > 63 ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(subdomain)
  )
    throw new FlockbotError("invalid_configuration");
  return subdomain.toLowerCase();
}

export function normalizedGroupName(name: string): string {
  if (
    typeof name !== "string" ||
    !name.trim() ||
    name.length > 256 ||
    /\p{Cc}/u.test(name)
  )
    throw new FlockbotError("invalid_input", undefined, "not_submitted");
  return name.trim();
}
