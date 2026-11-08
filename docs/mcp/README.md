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
| `find_members` | Search active members in a selected group or Everyone; return bounded identities and selected contacts or group subscription dates |
| `member` | Read one identified member's identity and explicitly selected stored email/mobile phone with status |
| `member_groups` | List a chosen member's explicit group subscriptions with bounded output and visibility limits |
| `member_communication_status` | Read one member/group's email/SMS preferences and contact warnings without promising delivery |
| `member_latest_email_status` | Check recorded engagement on the group's latest distinct sent email; unsupported cases remain unknown |
| `group_members` | List a named group's subscribed members in bounded pages, with names by default |
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
`fields` (`email`, `mobilePhone`, `joinedOn`), and `limit` (1–50; default 50). Omitting a group
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
whitespace), or one exact stored email match when `email` is selected (ignoring
case), include `exactMatchUserId`. Email queries must select `email` to establish
that match. Assistants may continue the requested
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

For “when was alex@example.test added to Volunteers?”, use `find_members` with
that `groupName`, `searchTerm: "alex@example.test"`, and
`fields: ["email", "joinedOn"]`. Resolve the person before reporting the date.
For a follow-up after listing a group, reuse the chosen person and group and
call `group_members` with `fields: ["joinedOn"]` to read that roster's dates.
An omitted `joinedOn` means the field was not requested; it does not establish
that the member has no date. Fetch the field before answering a join-date question.
`joinedOn` is the selected group's reported subscription calendar date as
`YYYY-MM-DD`, converted from the observed English display format. A missing,
null, invalid or unrecognized date is `null` (unavailable). It is opt-in and is
not a profile field. Do not use Everyone's date for another group, infer a time
or timezone, or claim who added the person or whether this was their first-ever
subscription rather than a later rejoin. Those historical semantics are not
established by the captures.

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

For “Who are the members of Youth Ministry?”, call
`group_members({groupName: "Youth Ministry"})`. Exactly one `groupName` or
`groupId` is required; names use the existing case-insensitive unique match.
The tool returns a page of up to 100 `members`, `groupId`, an optional canonical
`groupName`, `offset`, `returnedCount`, `hasMore`, and `nextOffset`. Names and
internal identifiers are returned by default. Optional `fields` selects
`email`, `mobilePhone`, and/or `joinedOn` only when the task needs them.
For “when did Alex join?” after this roster, request `fields: ["joinedOn"]`
in the same group and match the already selected person by their internal ID.
Only a requested `joinedOn: null` establishes that the returned record's date
is unavailable. To answer whether anyone has a date, request `joinedOn` on
every page; omitted dates in the default roster do not answer that question.

Start at offset zero. If `hasMore` is true, request the returned `nextOffset`
with that `groupId` and the same selected fields until `hasMore` is false. Present names to the
user and keep member IDs internal. Do not describe a page as the whole group or
use `returnedCount` as a total while more pages remain. If paging fails or
records repeat across pages, explain that the list is partial rather than
silently skipping people or claiming completeness. The connector rejects
empty nonfinal pages, oversized pages, malformed rows and duplicate IDs within
a page. Paging is not an atomic snapshot of changing group membership.

These are the login-visible subscribed-member records with
`includeUnsubscribed=0`; pending and unsubscribed people are not included.
Contact-view responses are unsupported. Permission errors and missing member
arrays are errors, not empty groups. Each page uses one POST attempt within
the existing coordination/cancellation/authentication boundary, without a
preflight or automatic replay. General offset paging is supported by captured
UI code and the observed offset-100 request; later offsets and additional-page
termination have offline fixture coverage, without new live verification.

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

### Communication diagnostics

`member_communication_status` takes a resolved `userId`, exactly one `groupId`
or uniquely matching `groupName`, and optional `fields` (`email`, `mobilePhone`).
It returns the selected IDs/group name, the same three-state `membership`, and
`email` and `sms` facts. Each channel has `preference` (`enabled`, `disabled`,
`unknown`), `contactPresent` and `verified`. Email also has `isBadEmail`; SMS has
`stopReplied`. Missing diagnostic facts are `null`, not false. Only captured
numeric 0/1 preferences and boolean profile flags are accepted; malformed values
are errors. Explicit null/blank contacts mean no stored value; absent contacts
mean availability is unknown. Pending contacts never replace stored contacts.

Contact values are omitted by default. Selecting `email` adds `email.value`;
selecting `mobilePhone` adds `sms.value`, only when that stored field is present.
The phone associated with a STOP record is never returned. Group selection checks
all validated rows, including targets beyond the subscription list's 50-row cap.

`warnings` contains applicable codes: `email_preference_disabled`,
`sms_preference_disabled`, `email_contact_missing`, `sms_contact_missing`,
`email_contact_unverified`, `sms_contact_unverified`, `email_flagged_bad`, and
`sms_stop_reported`. These describe observed facts, not a complete list of delivery
blockers. An enabled preference can coexist with a missing, unverified or bad
contact. An empty warnings list is not an all-clear. Always retain the returned
`limitations`: suppressions are not assessed, settings do not establish delivery,
group visibility may be incomplete, and separate reads are not an atomic snapshot.

This operation performs the existing groups/profile POST reads within one
coordinated deadline, with no automatic retry, preference writes or suppression
lookup. Failure of either read returns an error, not partial diagnostic success.
The preference/STOP fields are supported by offline capture inspection; missing
fields and malformed/denied responses are simulated test cases. No live delivery
or Codex desktop verification is claimed.

### Latest group email engagement

`member_latest_email_status` takes a resolved `userId` and exactly one `groupId`
or uniquely matching `groupName`. It selects by original send time, not resend
activity, independently of whether the member received that email. It never
substitutes an older email addressed to the member.

`selection` is `selected` or `unknown`; `email` is either `{ id, publishedDate }`
or `null`. `publishedDate` preserves the upstream numeric publication timestamp.
`engagement` is `recorded_open`, `reported_unopened`, or `unknown`; `reason`
explains uncertainty, and `observedAt` is the lookup observation time. Retain the
returned `limitations`: tracking does not prove human reading or delivery,
engagement is not attributed to an individual resend, and separate reads are
not an atomic snapshot.

The conservative first version supports the captured ordinary-email feed. It
checks the first displayed note against email, group, and send metadata. Newer
non-email/unsent notes, ties, unsupported send histories, and inconsistent
metadata produce unknown selection rather than a scan through mixed content.
The member's stored surname must contain at least three characters for the
observed analytics search. Search matches are selected by stable member ID, not
by name; missing, duplicate, conflicting or unsupported recipient records remain
unknown. `member_not_in_search_results` means the member's ID was absent from
that bounded search response, not that the member does not exist or was not a
recipient. No result establishes non-recipient status. Names, contact values,
message content and upstream HTML are never returned. This bounded read uses the
existing saved session and coordinated deadline without preflight or retries.
Only offline behavior is verified; live and Codex desktop use remain unverified.

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
