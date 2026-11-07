import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { FlockbotError } from "../../../src/index.js";
import { Operation } from "../../../src/operation.js";
import { setTimeout as delay } from "node:timers/promises";
import type { BrowserConnection, BrowserStatus } from "./browser-connection.js";
import { BrowserConnectionError } from "./browser-runtime.js";
import { MCP_VERSION } from "./version.js";
import { UpdateChecker, type UpdateNotifications } from "./update-check.js";

const INSTRUCTIONS =
  "Use these tools for the user's Flocknote parish requests. Trust the saved session and call the requested tool directly; no preliminary status or authentication check is needed. " +
  "Member IDs are internal: identify people to the user by name and distinguishing contact details, not numeric IDs. " +
  "If sign-in is needed, ask for the parish subdomain and call connect; the user signs in on Flocknote's real website. " +
  "The connect call waits briefly for sign-in. When it returns ready, continue the user's original request without asking them to say they are signed in. Sign-in alone does not finish their parish task. " +
  "Only if connect still returns pending should you ask the user to finish sign-in and let you know, then check status once. " +
  "Never request passwords, codes, cookies, browser storage, arbitrary URLs or scripts. " +
  "For additions use a known groupId, or supply the user's groupName for a case-insensitive unique match to resolve it in the same call. List groups only when the choice is unclear. " +
  "For an existing person, use find_members first unless their user ID is already known. Continue directly only when exactMatchUserId identifies one exact full-name or selected-email match in complete results; duplicate, similar or incomplete matches require clarification. When searching by a supplied email, request fields:[\"email\"] to match that stored contact. Completeness covers only the selected group's active-member search, not inactive or inaccessible users. Request contact fields only when needed for the user's task. " +
  'Resolving an ambiguous name is a reason to request contact fields. Before asking which person, use find_members with the same search and group and fields:["email"]; request mobilePhone only if email is missing or does not distinguish the candidates. Present the distinguishing email addresses or phone details and ask which person the user means. Never ask the user to choose between member IDs unless they explicitly requested IDs. Keep each choice\'s ID internal, then resume the original task with that userId after the user chooses. If available contacts still do not distinguish the records, explain that and ask for a known email or phone; do not invent differences or guess a record. ' +
  "Use member with the chosen userId and selected fields for contact questions. Without fields it returns identity only. Report stored unverified or bad email status accurately; unavailable or null values are not a new address, and pending contacts never replace stored ones. " +
  "Use member_groups to list a selected person's explicitly confirmed subscriptions, and is_member for one selected group. Missing groups mean unknown, not nonmembership. Proxy-only relationships with isSubscribed false are not subscriptions. Membership-read failures never mean no membership. " +
  'For when someone joined a group, use find_members within that requested group with fields:["email","joinedOn"] when identifying by email. joinedOn is Flocknote\'s reported subscription date for the searched group, not a profile creation date or another group\'s date. A null joinedOn means the date is unavailable; do not guess. Report only the calendar date: no precise time, timezone, who added them, or first-ever/rejoin history is established. Resolve the person before answering and keep member IDs internal. ' +
  "When a tool includes update metadata, answer the parish request first, then briefly mention the available Flockbot version (label prereleases) and say ‘Update Flockbot’ to install it. Mention it once per conversation unless asked again. Do not interrupt sign-in, hide an error or unknown write outcome, or install automatically. For an explicit update request, follow the canonical Flockbot guide, not the older installed setup script. " +
  "Add members only when requested, after resolving the parish, group and contact details. " +
  "Never repeat a write with outcome unknown: tell the user to check Flocknote before deciding what to do.";

const MESSAGES: Readonly<Record<string, string>> = {
  not_configured:
    "Ask for the parish subdomain, then open Flocknote sign-in with connect.",
  pending:
    "Finish sign-in in the Flocknote browser window on this computer. When reconnecting, use the original Flocknote login; switch logins on the website if needed. Keep credentials and codes out of chat, then check status.",
  ready:
    "The saved local Flocknote session is ready for use. Authentication is checked only after a relevant operation fails.",
  action_required:
    "Sign in again using connect. Enter passwords and codes only on Flocknote's website.",
  authentication_required:
    "The session needs sign-in. Use connect to open Flocknote on this computer.",
  connection_changed:
    "The selected parish or Flocknote login differs from the saved connection. Restore the original login in the sign-in window, or explicitly forget the old connection through local setup before replacing it.",
  connection_busy:
    "Another local Flockbot operation or sign-in is using the browser. Wait for it to finish.",
  browser_unavailable:
    "The dedicated browser could not be used. Check for browser or OS prompts, then retry from this computer's desktop. Run plugin setup if the browser runtime is missing.",
  profile_unavailable:
    "The local browser profile could not be accessed. Check this OS user's profile permissions.",
  broker_unavailable:
    "The local browser owner is unavailable. A later request can reconnect; never repeat a write with outcome unknown.",
  group_not_found:
    "No group matches that name (matching ignores case). List groups and select the intended identifier.",
  everyone_not_found:
    "Everyone is unavailable in this parish. Supply an explicit groupId or groupName for the member search.",
  group_ambiguous:
    "More than one group has that name. List groups and select the intended identifier.",
  permission_denied: "Flocknote denied access to this parish or operation.",
  invalid_input:
    "Check the group identifier, member names and contact details.",
  invalid_configuration:
    "Supply only the parish subdomain, such as example-parish.",
  invalid_response:
    "Flocknote returned an unexpected response. The operation could not be confirmed.",
  authentication_protocol_error:
    "Flocknote sign-in could not be verified from its response.",
  redirect_rejected:
    "Flocknote redirected the request. The operation was stopped.",
  upstream_rejected: "Flocknote did not accept the request.",
  transport_failed: "The Flocknote request could not be completed.",
  operation_timeout: "The operation timed out.",
  operation_cancelled: "The operation was cancelled.",
  write_outcome_unknown:
    "The write may have completed. Check Flocknote before deciding whether to submit it again.",
};

function statusMessage(status: BrowserStatus): string | undefined {
  const diagnostic = status.setupError
    ? MESSAGES[status.setupError]
    : undefined;
  return diagnostic && status.state === "action_required"
    ? `${diagnostic} ${MESSAGES.action_required}`
    : MESSAGES[status.state];
}

function result(body: Record<string, unknown>, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(body) }],
    structuredContent: body,
    ...(isError ? { isError: true } : {}),
  };
}

export type FlocknoteConnection = Pick<
  BrowserConnection,
  | "status"
  | "connect"
  | "groups"
  | "count"
  | "findMembers"
  | "member"
  | "memberGroups"
  | "isMember"
  | "addMember"
  | "addMemberByName"
  | "close"
>;

async function connectForTurn(
  connection: FlocknoteConnection,
  subdomain: string,
  signal: AbortSignal,
  waitMs: number,
  pollMs: number,
): Promise<BrowserStatus> {
  // Keep the original MCP call alive, not a new authentication request or a
  // background chat-wakeup service. Browser ownership/setup keeps its own budget.
  const op = new Operation(
    { timeoutMs: waitMs, maxReadRetries: 0 },
    undefined,
    { signal },
  );
  let latest: BrowserStatus | undefined;
  try {
    return await op.run(async () => {
      op.check();
      latest = await connection.connect(subdomain);
      op.check();
      const parish = subdomain.toLowerCase();
      if (latest.state !== "not_configured" && latest.parish !== parish)
        throw new BrowserConnectionError("connection_changed");
      if (latest.state !== "pending") return latest;
      while (true) {
        const status = await connection.status({ signal: op.signal });
        op.check();
        if (status.state !== "not_configured" && status.parish !== parish)
          throw new BrowserConnectionError("connection_changed");
        latest = status;
        if (status.state !== "pending") return status;
        await delay(pollMs, undefined, { signal: op.signal }).catch(
          (error: unknown) => {
            op.check();
            throw error;
          },
        );
        op.check();
      }
    });
  } catch (error) {
    if (
      error instanceof FlockbotError &&
      error.code === "operation_timeout" &&
      latest?.state === "pending"
    )
      return latest;
    throw error;
  }
}

export function createFlocknoteServer(
  connection: FlocknoteConnection,
  options: {
    signInWaitMs?: number;
    signInPollMs?: number;
    updates?: UpdateNotifications;
  } = {},
) {
  // Leave headroom below Codex's documented default 60-second tool timeout.
  const waitMs = options.signInWaitMs ?? 45_000;
  const pollMs = options.signInPollMs ?? 500;
  if (
    !Number.isFinite(waitMs) ||
    waitMs <= 0 ||
    waitMs > 45_000 ||
    !Number.isFinite(pollMs) ||
    pollMs <= 0
  )
    throw new FlockbotError("invalid_configuration");
  const server = new McpServer(
    { name: "flockbot", version: MCP_VERSION },
    { instructions: INSTRUCTIONS },
  );
  const respond = (body: Record<string, unknown>, isError = false) => {
    // Update discovery is optional; it must never replace a parish result/error.
    try {
      const update = options.updates?.notice();
      return result({ ...body, ...(update ? { update } : {}) }, isError);
    } catch {
      return result(body, isError);
    }
  };
  const guarded = async (work: () => Promise<Record<string, unknown>>) => {
    try {
      options.updates?.touch();
    } catch {
      /* Optional update check. */
    }
    try {
      return respond(await work());
    } catch (error) {
      const known =
        error instanceof FlockbotError ||
        error instanceof BrowserConnectionError;
      const code =
        known && MESSAGES[error.code] ? error.code : "connector_unavailable";
      return respond(
        {
          ok: false,
          code,
          message:
            MESSAGES[code] ??
            "The local connector could not complete the operation.",
          ...(error instanceof BrowserConnectionError && error.stage
            ? { stage: error.stage }
            : {}),
          ...(known && error.outcome ? { outcome: error.outcome } : {}),
        },
        true,
      );
    }
  };
  const groupId = z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/);
  server.registerTool(
    "status",
    {
      title: "Check local Flocknote connection",
      description:
        "Report saved local connection state without opening a browser or making an authentication request. Use for connection questions or after sign-in; ordinary work needs no preliminary status call. Ready means sign-in previously completed, not a fresh live check.",
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (extra) =>
      guarded(async () => {
        const status = await connection.status({ signal: extra.signal });
        return {
          ok: true,
          ...status,
          message: statusMessage(status),
        };
      }),
  );
  server.registerTool(
    "connect",
    {
      title: "Sign in to Flocknote",
      description:
        "Use when sign-in is needed for the user's request, or to connect/reconnect. Opens Flocknote's real website in a dedicated local browser and waits briefly for sign-in. On ready, continue the original task without asking for a done message. If still pending, finish sign-in and check status later. Takes no credentials. Never repeat a write with unknown outcome.",
      inputSchema: {
        subdomain: z
          .string()
          .min(1)
          .max(63)
          .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ subdomain }, extra) =>
      guarded(async () => {
        const status = await connectForTurn(
          connection,
          subdomain,
          extra.signal,
          waitMs,
          pollMs,
        );
        return {
          ok: true,
          ...status,
          message:
            status.state === "ready"
              ? "Sign-in is complete. Continue the user's original request now without asking them to confirm sign-in. Never repeat a write with unknown outcome."
              : statusMessage(status),
        };
      }),
  );
  server.registerTool(
    "groups",
    {
      title: "List parish groups",
      description:
        "Use when the group choice is unclear or to list parish groups. Reuses discovery for up to 60 seconds; refresh forces discovery. Trusts the saved session without a preflight check. Returns only identifiers, names and Everyone status.",
      inputSchema: { refresh: z.boolean().optional() },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ refresh }, extra) =>
      guarded(async () => ({
        ok: true,
        groups: await connection.groups({
          signal: extra.signal,
          ...(refresh === undefined ? {} : { refresh }),
        }),
      })),
  );
  server.registerTool(
    "subscriber_count",
    {
      title: "Count subscribers in a group",
      description:
        "Use when the user asks how many subscribers a selected group has. Supply its identifier from groups. Fetches a current count without member records.",
      inputSchema: { groupId },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ groupId }, extra) =>
      guarded(async () => ({
        ok: true,
        groupId,
        subscriberCount: await connection.count(groupId, {
          signal: extra.signal,
        }),
      })),
  );
  server.registerTool(
    "find_members",
    {
      title: "Find parish members",
      description:
        "Find existing active parish members by general text search. Select groupId or a unique groupName, or omit both to search dynamically discovered Everyone. Returns at most 50 identity candidates and scoped result counts; fields optionally selects email/mobilePhone/joinedOn. joinedOn is the reported subscription calendar date (YYYY-MM-DD or null) in the searched group; explicitly select the requested group for join-date questions. Continue directly only with exactMatchUserId from complete results (unique exact name or selected email). For ambiguous names, request email first and mobilePhone if needed, then clarify using distinguishing contacts. Member IDs are internal; do not ask users to choose numeric IDs. No preliminary status check and no automatic retry.",
      inputSchema: {
        searchTerm: z.string().min(1).max(256),
        groupId: groupId.optional(),
        groupName: z.string().min(1).max(256).optional(),
        fields: z
          .array(z.enum(["email", "mobilePhone", "joinedOn"]))
          .max(3)
          .optional(),
        limit: z.number().int().min(1).max(50).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (input, extra) =>
      guarded(async () => ({
        ok: true,
        ...(await connection.findMembers(input, { signal: extra.signal })),
      })),
  );
  server.registerTool(
    "member",
    {
      title: "Read selected member details",
      description:
        "Read one identified parish member by userId from a resolved search or known record. Returns only identity by default; fields optionally selects email and/or mobilePhone with stored-value status. Missing fields are unavailable; pending contacts never replace stored ones. A stored unverified or bad address does not establish delivery. Uses the saved session with no preliminary status check or automatic retry.",
      inputSchema: {
        userId: groupId,
        fields: z
          .array(z.enum(["email", "mobilePhone"]))
          .max(2)
          .optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ userId, fields }, extra) =>
      guarded(async () => ({
        ok: true,
        member: await connection.member(userId, fields, {
          signal: extra.signal,
        }),
      })),
  );
  server.registerTool(
    "member_groups",
    {
      title: "List a member's group subscriptions",
      description:
        "Read a chosen user's explicitly subscribed groups, returning at most 50 IDs/names with observed/returned counts and truncation. A proxy-only relationship is not a subscription. Complete is false because this response does not establish an exhaustive view; absence is not proof of nonmembership. Takes a resolved userId, with no preliminary status check or automatic retry.",
      inputSchema: { userId: groupId },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ userId }, extra) =>
      guarded(async () => ({
        ok: true,
        ...(await connection.memberGroups(userId, { signal: extra.signal })),
      })),
  );
  server.registerTool(
    "is_member",
    {
      title: "Check a person's group membership",
      description:
        "Check one resolved userId against exactly one groupId or a unique case-insensitive groupName. Returns membership as member, not_member (explicit false/proxy-only relationship), or unknown (group absent from the authorized response). Errors are never negative membership. Checks all validated rows before list clipping, with no preliminary status check or automatic retry.",
      inputSchema: {
        userId: groupId,
        groupId: groupId.optional(),
        groupName: z.string().min(1).max(256).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ userId, ...selector }, extra) =>
      guarded(async () => ({
        ok: true,
        ...(await connection.isMember(userId, selector, {
          signal: extra.signal,
        })),
      })),
  );
  server.registerTool(
    "add_member",
    {
      title: "Add a member to a parish group",
      description:
        "Use only for an explicitly requested membership addition. Supply exactly one of a known groupId or the user's groupName for a case-insensitive unique match; a unique name is resolved in this call without a separate group/status lookup. Can change membership and cause Flocknote notifications. Returns only success. Never automatically retry an unknown write outcome.",
      inputSchema: {
        groupId: groupId.optional(),
        groupName: z.string().min(1).max(256).optional(),
        firstName: z.string().min(1).max(256),
        lastName: z.string().min(1).max(256),
        email: z.string().max(320).optional(),
        mobilePhone: z.string().max(64).optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ groupId, groupName, ...member }, extra) =>
      guarded(async () => {
        if (Boolean(groupId) === Boolean(groupName))
          throw new FlockbotError("invalid_input", undefined, "not_submitted");
        const added = groupId
          ? await connection.addMember(groupId, member, {
              signal: extra.signal,
            })
          : await connection.addMemberByName(groupName ?? "", member, {
              signal: extra.signal,
            });
        return { ok: true, ...added };
      }),
  );
  server.server.onclose = () => {
    try {
      options.updates?.close();
    } catch {
      /* Optional update check. */
    }
    void connection.close();
  };
  return server;
}

export async function serveFlocknote(
  connection: FlocknoteConnection,
): Promise<void> {
  const server = createFlocknoteServer(connection, {
    updates: new UpdateChecker(),
  });
  const close = async () => {
    await connection.close();
    await server.close();
  };
  process.once("SIGINT", () => {
    void close();
  });
  process.once("SIGTERM", () => {
    void close();
  });
  await server.connect(new StdioServerTransport());
}
