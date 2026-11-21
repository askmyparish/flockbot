import type { DraftProgress } from "../../../src/errors.js";
import type { DraftImage } from "./draft-images.js";

export interface FlocknoteSession {
  request(
    path: string,
    method?: "GET" | "POST",
    body?: string,
    photo?: DraftImage,
  ): Promise<unknown>;
  signIn(): Promise<void>;
  finishSignIn?(): Promise<void>;
  isOpen?(): boolean;
  close(): Promise<void>;
}

export interface SessionOptions {
  readonly profile: string;
  readonly origin: string;
  readonly interactive: boolean;
}

export type SessionFactory = (
  options: SessionOptions,
) => Promise<FlocknoteSession>;

/**
 * Local connection failures carrying fixed codes and optional safe startup stages.
 * Session exception text and profile contents stay outside this error contract.
 */
export class ConnectionError extends Error {
  constructor(
    readonly code:
      | "browser_unavailable"
      | "profile_unavailable"
      | "not_configured"
      | "connection_busy"
      | "connection_changed",
    readonly outcome?: "not_submitted" | "unknown",
    readonly stage?: "launch" | "request_context" | "sign_in" | "close",
    readonly draftProgress?: DraftProgress,
  ) {
    super(code);
    this.name = "ConnectionError";
  }
}

/** Internal endpoints only. Neither an MCP tool nor its arguments can set a URL. */
export function allowedEndpoint(path: string, method: string): boolean {
  if (method === "GET")
    return (
      [
        "user/userData",
        "dashboard",
        "navigation/groups",
        "network/getMetadata",
      ].includes(path) ||
      /^group\/[A-Za-z0-9_-]+\/getSubscriberCount$/.test(path) ||
      /^group\/[A-Za-z0-9_-]+\/notes\?ajax&more$/.test(path) ||
      /^note\/[A-Za-z0-9_-]+\/(?:analyticsSummary|analytics2)\?ajax$/.test(path)
    );
  return (
    method === "POST" &&
    ([
      "network/getMetadata",
      "supersearch/query?ajax",
      "composer/editNote",
      "composer/createNote",
      "composer/duplicateNote",
      "composer/save2",
      "composer/saveModule",
      "composer/saveSection",
      "composer/saveLayout",
    ].includes(path) ||
      /^network\/\d+\/writeNewNote\?ajax$/.test(path) ||
      /^group\/[A-Za-z0-9_-]+\/addToGroupByAdmin$/.test(path) ||
      /^note\/[A-Za-z0-9_-]+\/(?:searchAnalytics|detailedAnalytics)\?ajax$/.test(
        path,
      ) ||
      /^group\/[A-Za-z0-9_-]+\/(?:people\?ajax|filter)$/.test(path) ||
      /^group\/[A-Za-z0-9_-]+\/people\/[1-9]\d{0,15}\?ajax&more$/.test(path) ||
      /^user\/[A-Za-z0-9_-]+\/(?:profile|groups)$/.test(path))
  );
}

export { AuthenticationSuspectedError } from "../../../src/errors.js";
