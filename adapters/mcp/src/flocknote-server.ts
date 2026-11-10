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
  "For who belongs to a group, use group_members with the user's groupName directly. Return names, keeping IDs internal and contact fields omitted unless requested. Follow nextOffset with the returned groupId until hasMore is false before presenting the full visible list. Track member IDs internally across pages; if a page repeats records, fails, or membership changes prevent consistent paging, stop and explain that the list is partial. Never present the first page as the whole group while hasMore is true. Pending and unsubscribed people are not included, and the login's permissions may limit visibility. " +
  'For when someone joined a group, request fields:["joinedOn"] with group_members in that group, or use find_members within that requested group with fields:["email","joinedOn"] when identifying by email. On follow-up questions, reuse the already selected person and group. An omitted joinedOn means it was not requested, not that Flocknote has no date: fetch it before answering. Only a requested joinedOn returned as null means the date is unavailable. To check whether any group members have dates, request joinedOn on every page before making a group-wide claim. joinedOn is Flocknote\'s reported subscription date for the selected group, not a profile creation date or another group\'s date. Report only the calendar date: no precise time, timezone, who added them, or first-ever/rejoin history is established. Resolve the person before answering, keep member IDs internal and never guess a date. ' +
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
  | "memberCommunicationStatus"
  | "memberLatestEmailStatus"
  | "emailAnalytics"
  | "groupMembers"
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
    "group_members",
    {
      title: "List people in a group",
      description:
        "List a group's subscribed members by groupId or a unique case-insensitive groupName, such as Youth Ministry. Returns one page of up to 100 names/internal IDs; fields optionally selects email/mobilePhone/joinedOn only when needed. For join-date questions request joinedOn, the selected group's reported subscription calendar date (YYYY-MM-DD or null). Omitted joinedOn means not requested; it does not mean no date exists. Start at offset 0. When hasMore is true, continue with nextOffset, the returned groupId and the same fields; do not call a partial page the whole group. Stop on repeated records or an error and report a partial list. Excludes pending and unsubscribed people; visibility is limited by the login. Uses the saved session with no preflight or automatic retry.",
      inputSchema: {
        groupId: groupId.optional(),
        groupName: z.string().min(1).max(256).optional(),
        offset: z
          .number()
          .int()
          .min(0)
          .max(Number.MAX_SAFE_INTEGER - 100)
          .optional(),
        fields: z
          .array(z.enum(["email", "mobilePhone", "joinedOn"]))
          .max(3)
          .optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (input, extra) =>
      guarded(async () => ({
        ok: true,
        ...(await connection.groupMembers(input, { signal: extra.signal })),
      })),
  );
  server.registerTool(
    "member_communication_status",
    {
      title: "Read member communication settings and warnings",
      description:
        "Explain observed email/SMS settings and contact concerns for one resolved userId and exactly one groupId or unique groupName. Returns membership, stored group preferences, contact availability/verification, bad-email and reported SMS STOP flags, warnings and limitations. Missing facts remain unknown, not false. Contact values are omitted unless fields selects email/mobilePhone. No suppression lookup or changes; settings and an empty warnings list never prove delivery. Separate reads are not an atomic snapshot. Uses the saved session without a preliminary status check or automatic retry.",
      inputSchema: {
        userId: groupId,
        groupId: groupId.optional(),
        groupName: z.string().min(1).max(256).optional(),
        fields: z
          .array(z.enum(["email", "mobilePhone"]))
          .max(2)
          .optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (input, extra) =>
      guarded(async () => ({
        ok: true,
        ...(await connection.memberCommunicationStatus(input, {
          signal: extra.signal,
        })),
      })),
  );
  server.registerTool(
    "email_analytics",
    {
      title: "Read an email's aggregate analytics",
      description:
        "Read Flocknote's reported aggregate counts using exactly one emailId, groupId or unique groupName. An explicit ID may select an older email; a group selects the newest original send, not latest resend, independently of recipient inclusion. Unsupported or ambiguous group selection remains unknown without older fallback; separate reads are not atomic. Returns normalized selector, resolved group/email identity, raw publication timestamp, observation time and nine categories; missing categories are unknown, not zero. Counts do not establish unique recipients, delivery or human reading, and cannot be attributed to an individual resend. No derived rates, recipients, message content, preflight, automatic retries or writes. Explicit non-email notes return unsupported_email_type with no counts.",
      inputSchema: z
        .object({
          emailId: groupId.optional(),
          groupId: groupId.optional(),
          groupName: z.string().min(1).max(256).optional(),
        })
        .strict(),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (input, extra) =>
      guarded(async () => ({
        ok: true,
        ...(await connection.emailAnalytics(input, { signal: extra.signal })),
      })),
  );
  server.registerTool(
    "member_latest_email_status",
    {
      title: "Check a member's latest group email engagement",
      description:
        "Check one resolved userId against the group's newest distinct originally sent email, using exactly one groupId or unique groupName. Resends do not change selection; never fall back to an older email addressed to the member. Returns recorded_open, reported_unopened or unknown with a reason, email ID and raw publication timestamp. Supports the observed ordinary-email feed; mixed, ambiguous or unsupported feeds and send histories remain unknown. A surname of at least three characters is required for the observed analytics search; matches use stable member IDs, not names. Missing matches never prove non-recipient status. Opens do not prove human reading or delivery, and separate reads are not atomic. No contacts, message content, preflight, automatic retry or writes.",
      inputSchema: {
        userId: groupId,
        groupId: groupId.optional(),
        groupName: z.string().min(1).max(256).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (input, extra) =>
      guarded(async () => ({
        ok: true,
        ...(await connection.memberLatestEmailStatus(input, {
          signal: extra.signal,
        })),
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
