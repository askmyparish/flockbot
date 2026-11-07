# Codex MCP candidate

Flockbot exposes defined Flocknote operations to local Codex through a dedicated
persistent Chromium profile. Staff sign in on Flocknote's real website. The
browser owns authentication and cookies; ordinary tools make internal API requests
without screenshots, mouse/keyboard automation, password collection or cookie
exports.

**Private candidate, not a supported release.** Offline unit/MCP tests and the
opt-in real-browser fixture checks pass. Authorized test-parish sign-in, session
reuse, group discovery and subscriber counts passed with the installed macOS
runtime. Explicitly requested live member additions also returned confirmed
success. Locked/denied credential-store behavior, clean Codex desktop onboarding
and Windows execution still need verification. No GitHub runtime release has been
published by these changes.

## Tools

| Tool | Behavior |
| --- | --- |
| `status` | Report saved readiness or pending/required setup without a live request |
| `connect` | Open real Flocknote sign-in for a parish subdomain |
| `groups` | Return group identifiers, names and Everyone status; optional `refresh` |
| `subscriber_count` | Fetch a current count without member records |
| `find_members` | Search active members in a selected group or Everyone; return bounded identities and explicitly selected contact fields |
| `member` | Read one identified member's identity and explicitly selected stored email/mobile phone with status |
| `member_groups` | List a chosen member's explicit group subscriptions with bounded output and visibility limits |
| `is_member` | Check one chosen member/group relationship as `member`, `not_member`, or `unknown` |
| `add_member` | Add once by `groupId` or case-insensitive unique `groupName`; return only success |

The MCP server publishes input schemas and workflow instructions. It offers no raw
HTTP, arbitrary URL, script evaluation, credential or browser-inspection tool.
Membership writes are never automatically repeated. A failure after possible
submission reports `outcome: unknown`; check Flocknote before deciding to
resubmit.

Ordinary operations trust the saved session and make no preliminary authentication
request. Status reports saved readiness without opening a browser; `ready` means
sign-in previously completed, rather than a fresh live check. When a group name is
known, pass it directly to the addition tool; only missing or ambiguous names need
a separate group-list request. Discovery is cached for 60 seconds per connection;
`groups({refresh: true})` bypasses that cache. Modern discovery overlaps
its independent navigation/metadata reads and drains both before releasing
coordination, including on failure. Counts are always fresh. A warm addition by
known ID or cached group name makes only its membership POST; cached group
discovery makes no HTTP request. Reconnect, browser replacement, forgetting and
operation errors clear discovery. A cached group does not guarantee current
permission; Flocknote still authorizes the membership POST.

An actual HTTP 401/403, redirect, explicit `authorized: false`, or unexpected HTML
where a domain response is required can indicate expired authentication. Only
after such a failure does the connector make one `user/userData` request to
distinguish confirmed expiry from permission or response errors. Confirmed expiry
pauses the connection for manual sign-in. An inconclusive check preserves the
original error and readiness. Business rejections, malformed JSON/domain values,
network failures and timeouts do not trigger an authentication probe. No failed
operation is automatically replayed, including a POST rejected for auth reasons;
its write outcome remains unknown after possible submission.

Member search accepts `searchTerm`, optional `groupId` or `groupName`, optional
`fields` (`email`, `mobilePhone`), and `limit` (1–50; default 50). Omitting a group
uses the dynamically discovered Everyone group; a parish without Everyone needs
an explicit group. A known ID skips discovery, and a group name requires a unique
case-insensitive match. The connector reads the group's general-search filter
definition before submitting the observed active-member query, without assuming
a permanent filter ID.

Results include `members`, upstream `resultCount`, `returnedCount`, `complete`,
and the selected `groupId`. Completeness covers that group's active-member query;
it does not establish coverage of inactive members or records the login cannot
see. Server omissions or the requested limit make the result incomplete. Only
complete results with one exact full-name match (ignoring case and repeated
whitespace) include `exactMatchUserId`. Assistants may continue the requested
lookup with that identifier; duplicate, similar or incomplete matches require
clarification. Empty results are scoped to the query, not proof that a person
has no parish record.

Member IDs are internal lookup keys, not choices to present to parish staff.
Before asking the user to distinguish same-name records, repeat the search in
the same group with `fields: ["email"]`. If email is absent or identical, request
`mobilePhone` as needed. Ask using only the distinguishing contact details, keep
their corresponding IDs internal, and continue the original task once the user
chooses. If the contacts do not distinguish the records, explain that limitation
and ask for a known email or phone rather than guessing or presenting numeric IDs.

Search returns only identifiers and names by default. Selected contacts include
their stored value and verification flag; a blank/null value remains null, and
verification is not a delivery guarantee. Other contact, role and UI fields are
discarded. These read operations use the observed POST contracts without being
automatically replayed. No member-search live verification is claimed here.

`member` takes a chosen `userId` and optional `fields` (`email`,
`mobilePhone`). Without fields it returns only the member's ID and names, under
`member`. A selected email includes `value`, `verified`, and `isBadEmail`; a
selected mobile phone includes `value` and `verified`. These are Flocknote's
stored values and flags, not a promise that a message will arrive. The profile
must belong to the requested person in the current parish and permit profile
viewing. Permission to edit contacts is separate and is not required to read
contact values that Flocknote returns in an authorized profile.

An explicit null or blank stored contact is returned as `value: null`. If a
selected key is missing from the profile, that field is omitted and named in
`unavailableFields`; it is not treated as proof that the person has no contact
value. Pending contact values are never substituted for stored contacts. Missing
keys and non-null pending contacts are simulated offline cases; the captured
profiles establish string email, string/null mobile and null pending values.
Each call fetches a fresh profile with one POST attempt and no authentication
preflight. No live verification of this tool is claimed.

`member_groups({userId})` returns only explicitly subscribed group IDs/names,
with `observedCount`, `returnedCount`, `truncated`, and `complete: false`. At most
50 subscriptions are shown. The observed response has no exhaustive-visibility
guarantee, even when presentation is not truncated. Proxy-only relationships
with `isSubscribed: false` are excluded from the subscription list. Their false
flag is supported by captured Flocknote UI code and exercised with simulated
JSON fixtures; the captured membership response itself has only true rows.

`is_member` takes a chosen `userId` and exactly one `groupId` or uniquely matching
case-insensitive `groupName`. It returns the selected IDs, a group name when
known, and `membership`: `member` for an explicit true subscription,
`not_member` for an explicit false relationship, or `unknown` when the selected
group is absent. Available groups alone do not establish nonmembership. A denied,
malformed, conflicting, or failed response produces an error. Checks inspect
all validated rows before list presentation is clipped. These tools fetch fresh
data using one membership POST attempt, preserve the current connection's
coordination/cancellation/authentication boundaries, and expose no channel
preferences or administrative capabilities. No live verification is claimed.

## Develop and verify

Use Node.js 22.13+ and `bin/setup` for development.

```sh
npm run build:mcp
npm run check
npm run test:mcp:browser
```

The last command requires the pinned browser runtime. Install it explicitly once:

```sh
PLAYWRIGHT_BROWSERS_PATH="$PWD/adapters/mcp/.cache/browsers" node node_modules/playwright/cli.js install chromium --no-shell
```

That test intercepts every page/API request, uses fictional identities and session
cookies, disables browser DNS, and never contacts Flocknote. Its temporary
profiles use Playwright's test-only credential settings so tests don't access a
real OS secret store. Ordinary `npm test` skips this opt-in check and downloads
nothing.

Build the prepared Codex runtime bundles and refresh the source plugins' integrity
pins with:

```sh
npm run package:codex
```

This explicitly downloads checksum-pinned official Node runtimes and writes
ignored ZIPs under `adapters/mcp/artifacts/codex`. It does not publish or register
anything. The source plugins pin those exact archives; rerun packaging after
runtime changes before publishing the matching version's release. Do not
replace an existing release's immutable assets; bump the version and pins for
later releases. The [release runbook](./releases.md) describes Changesets release
PRs, CI preview artifacts, tagged releases and build provenance. Publication uses
`npm run package:codex -- --verify-pins` to check reviewed pins without rewriting them.

See [setup and distribution](./setup.md) and the [browser verification
checklist](./browser-verification.md).

## Browser and storage boundary

The browser profile lives beneath this OS user's normal Flockbot application-data
folder, outside plugin caches and immutable downloaded runtimes. On macOS the
parent folders are owner-only; Windows uses the current user's local application
data. The browser profile is sensitive, including cookies, local storage and
history. Not every browser file is encrypted. Keep it on a local, user-owned disk,
out of repositories, synced folders, backups shared with others, and diagnostic
uploads. Browser-native credential protection is retained: production removes
Playwright's basic-password-store/mock-keychain defaults and enables Chromium's
sandbox. Normal macOS sign-in and session reuse passed with these production
settings; locked/denied credential-store behavior and Windows still need testing.

A detached local owner holds a SQLite OS lock for its browser's whole lifetime.
MCP processes send defined operations to that owner through private local IPC; an
internal queue serializes sign-in, requests and forgetting. Cancellation does not
release a running browser callback early. Process death releases the OS lock. The
owner closes Chromium after five idle minutes; the next request starts it again
using the saved profile. Closing a chat leaves the owner available for other local
chats. There is no background membership queue or automatic write replay.

Interactive sign-in tolerates inconclusive poll failures until its setup deadline.
A definite permission failure, a closed browser, or a closed sign-in tab ends
setup; status preserves a fixed `setupError` code and, for browser failures, a
fixed `setupStage` when available. Failed setup status includes instructions to
reconnect. A different login remains open for correction and is reported as
`connection_changed` if the setup deadline expires. Tools called during sign-in
report `connection_busy` promptly. Queue-wait deadlines also report busy, while
caller cancellation remains `operation_cancelled`. The connection uses the same
reused-session lifecycle in production and its lifecycle tests.

On macOS the Unix socket and descriptor are owner-only. On Windows the descriptor
is protected with current-user DPAPI. Requests and replies use HMAC authentication
with an owner-specific key that never travels over IPC. Nonces reject replay; the
owner rotates before its bounded replay ledger fills. The descriptor contains the
socket/pipe address, protocol/runtime identifiers and this IPC key, never a
Flocknote credential. Windows execution remains unverified. Connection metadata
contains only a parish, opaque generation, internal login identifier, readiness
state and optional fixed setup diagnostic code/stage. Parish replacement requires explicitly forgetting the old connection. The
original login is checked during sign-in and auth-failure diagnostics; the
dedicated profile is trusted between those checks. Closing or expiring sign-in
leaves `action_required`; abandoned pending metadata is detected on the next
status check.

The owner starts Chromium on demand and reuses it across operations and MCP
processes. Each parish operation performs its bounded endpoint request(s) using
the saved session. `user/userData` is used during sign-in and to diagnose
auth-like failures. Interactive setup keeps the authenticated browser available
and minimizes its request window where supported; later cold starts are headless.
A session-only cookie is retained through Chromium's session-restore mechanism.
Before clean shutdown, the request page is moved to `about:blank`, so restoration
does not navigate to Flocknote before interception is attached. API requests use a
locally fulfilled inert page at the selected parish origin. They reject redirects,
bound response bodies, and return only validated domain results. Cookies rotate in
the browser naturally; the shared HTTP client's staged-cookie persistence rules do
not apply to this adapter. Group/count requests worked in the initial live check;
actual session-expiry rules and notification/duplicate effects still need
controlled checks. Authorized live membership POSTs succeeded with browser-native
same-origin requests; no extra CSRF header or UI automation was used.

No server-side session revocation or forensic deletion is promised by local
forgetting. Code updates retain the separate profile. Browser-profile downgrade,
synced disks, same-user malware isolation and signed-update continuity are not
proven. Relevant tool results are sent to the assistant provider; local credential
storage does not make parish data device-only.

## Scope

Shared resource modules live in `src/models`. The browser connection delegates
network/group discovery, subscriber counts, contact validation, membership request
construction and sign-in response parsing to those modules. It retains local
profile/session lifecycle, coordination, authentication diagnostics and uncertain
write handling. MCP tools retain their existing names, inputs and results.

This MCP adapter uses the browser's authentication and session storage. The shared
HTTP client and Zapier adapter retain their own authentication and storage contracts.
Claude distribution is outside this Codex-first candidate.

The [member-browsing discovery record](./discovery/member-browsing.md) documents
sanitized observations for possible future tools; it does not expand the current
connector's supported operations.

## Continue after browser sign-in

The MCP `connect` call stays active for up to 45 seconds, including
browser startup, while checking only saved local connection status. When login
finishes in that window, it returns `ready` and tells the assistant to continue
the original parish request without another user confirmation. The browser’s
existing five-minute sign-in lifecycle and private authentication flow are unchanged.

If sign-in takes longer, the tool returns truthful `pending` with the existing
finish-sign-in/status fallback. Cancellation stops waiting without resetting or
forgetting the connection. A closed/failed setup or changed parish cannot report
success. This fits beneath Codex’s documented default 60-second tool timeout; a
custom shorter host timeout may still cancel the call sooner. No user config is
edited to extend that timeout.

Login success is a prerequisite, not completion of the original task. Resume
read-only work after `ready`; never automatically repeat a write whose outcome is
unknown. Real desktop/TUI conversation continuation still needs manual host
verification; fixture-backed MCP calls do not prove model behavior.

Update notices appear in normal tool results when a cached public release check
finds a newer matching version. Say **Update Flockbot** to use the same guide-based
update flow while retaining sign-in. Checks run at most daily during use, tolerate
network failures quietly and never delay the parish operation for the network.
See [update notices](setup.md#update-notices) for timing and release selection.
