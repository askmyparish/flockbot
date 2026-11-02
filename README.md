# Flockbot

Flockbot connects parish workflows to [Flocknote](https://www.flocknote.com/)
through its internal API.

The TypeScript port supports password login, saved sessions, coordinated recovery,
group discovery, subscriber counts, member additions, and HTTP requests. A private
Zapier authentication candidate is available for offline development; MCP support
is still coming. The Ruby gem remains available during the move.

## TypeScript development

You'll need Node.js 22.12+ and npm. Ruby isn't needed for the TypeScript package.

```sh
bin/setup       # Install locked npm dependencies
bin/test        # Run offline tests
npm run check   # Run all checks and build the package
```

<details>
<summary>More development commands</summary>

The bin scripts work from any directory. They call `npm ci --ignore-scripts`
and `npm test`; CI uses those same npm commands on Node 22.

`npm run check` covers formatting, lint, types, tests, build, and package import.
Use `npm run format` to format files, or run individual checks with
`npm run format:check`, `npm run lint`, `npm run typecheck`, `npm run build`,
and `npm run test:package` (after building). To run a focused test:

```sh
bin/test -t "reuses cookies"
```

</details>

### Use a saved session

The package is private and unpublished for now. After building, import it from
`dist/index.js`. An adapter supplies protected, persistent `sessionStore` and
`coordinator` implementations:

```typescript
import { FlockbotClient } from "./dist/index.js";

const client = new FlockbotClient({
  subdomain: "example-parish",
  sessionStore,
  coordinator,
  configurationVersion: "credentials-v1",
});
const result = await client.get("dashboard");
```

To import an existing token, use `sessionFromToken("example-parish", savedToken)`
and save it through the adapter's coordinated revision check. Stored sessions are
credentials. Library-created state hides secrets during Node inspection, but JSON
and structured clones retain them for storage. Don't log serialized state.

### Log in with a password

Your adapter supplies a protected `SessionStore` and a `CredentialProvider`
that returns `{ email, password }`. Keep those credentials out of chats and logs.
The client doesn't pick a credential store or load environment files.

```typescript
const client = new FlockbotClient({
  subdomain: "example-parish",
  sessionStore,
  coordinator,
  configurationVersion: "credentials-v1",
  credentialProvider: {
    load: async () => secureCredentials.load(),
  },
});
await client.connect();
```

Here, `sessionStore`, `coordinator`, and `secureCredentials` come from your adapter.
`connect()` verifies a saved session without reading credentials and can renew it
once. `get("user/userData")` can also recover a confirmed invalid session; other
endpoints don't infer expiry. Call `connect()` before adapter work when verification
is needed. All requests can bootstrap a missing session. Submitted writes are
never renewed or replayed.

<details>
<summary>Authentication, recovery, and error details</summary>

Setup and saved-session checks keep cookie changes private until verification
succeeds. `connect()` returns no token or user details. A failed save retains
verified state in the same client for a later retry, provided the durable revision
has not changed. A peer update or reset discards that pending state. A save that
committed before throwing is reconciled by reloading its advanced revision.

A confirmed password mismatch or password-disabled response saves an intervention
record containing only a fixed reason and the nonsecret `configurationVersion`.
Later calls, including `connect({ forcePasswordLogin: true })`, return
`action_required` without attempting login. Change the adapter's configuration
version when credentials change, or call `clearSession()` from an authorized
operator interface. Neither mechanism stores a password in diagnostic state.
All clients for one connection must use its current configuration version; retire
old invocations when changing it. Session reset must not be exposed to ordinary
request callers. Forced password login still obeys coordination and intervention.

Authentication errors use fixed codes:

| Code | Meaning |
| --- | --- |
| `credentials_unavailable` | Credentials are missing or couldn't be loaded |
| `credentials_rejected` | A known password-mismatch response; intervention was saved |
| `authentication_required` | A confirmed invalid session remained after bounded recovery |
| `action_required` | Password login needs intervention or the connection is paused |
| `permission_denied` | Permission was denied; no password renewal |
| `authentication_unavailable` | A network failure, rate limit, or server error |
| `authentication_protocol_error` | An unexpected authentication response |

The observed invalid-session signal is specifically HTTP 200 from `user/userData`
with `success: true`, `userID: null`, and `authorized: false`. Its replacement
cookie is discarded. HTTP 401, HTTP 403, generic server errors, and similar bodies
from other endpoints never trigger renewal. HTTP 403 reports permission denial;
other unknown authentication shapes fail clearly. Other invalid-session and
permission signals still need controlled verification.

</details>

Flocknote may still send a login email during password setup. The client doesn't
request, fetch, or enter codes. Password-disabled handling uses simulated test
responses; real code challenges haven't been verified. Unknown responses fail
clearly rather than being guessed to mean a bad password.

### Read groups and subscriber counts

```typescript
const groups = await client.groups();
const choices = groups.map(({ id, name, shortName }) => ({ id, name, shortName }));
const everyone = groups.find((group) => group.isEveryone);
const count = await everyone?.subscriberCount();
const refreshed = await everyone?.subscriberCount({ force: true });
```

`groups()` discovers groups afresh; `everyoneGroup()` discovers and selects Everyone,
or returns `undefined` after a successful response without it. Discovery and uncached
counts verify the session and can recover once through the shared login lifecycle.
They read no member contact records. Failures throw `FlockbotError`.

<details>
<summary>Group identifiers, discovery, and count caching</summary>

Groups expose `id`, `name`, `shortName`, and `isEveryone`. IDs are strings for stable
choice values. Positive safe integer IDs become decimal strings; decimal string
IDs lose leading zeros without numeric conversion. Larger decimal strings retain
all digits. Other nonempty IDs containing only letters, digits, `_`, or `-` are
preserved. Unsafe numeric IDs and malformed required fields fail as
`invalid_response`; optional upstream fields are ignored. Names and short names
are trimmed, and HTML text entities are decoded without evaluating scripts.

Legacy dashboard `.group_item` markup supplies groups directly. Repeated IDs and
case-insensitive `everyone` short names keep the first legacy entry. The observed
structural rows with neither `data-shortname` nor `.group_name` are ignored;
partial group rows still fail. An all-structural page isn't an empty result. The
`fnReactHolder` dashboard shell triggers `navigation/groups` plus
`network/getMetadata`. Metadata supplies Everyone's ID and canonical `Everyone` /
`everyone` names, taking precedence over entries with that ID or an `everyone`
short name. Other duplicate IDs keep their first entry; other distinct IDs are
retained even when their short names match. No parish-specific ID is built in.

The supported explicit empty fallback is `{"groups": []}` together with
`{"everyoneGroupID": null}`. This no-Everyone shape is simulated in tests and
has not been verified live. A non-null metadata ID still yields Everyone when
navigation groups are empty. Missing metadata, unknown dashboard/login pages,
malformed JSON and malformed required fields fail rather than becoming empty
collections. HTTP 403 stays `permission_denied`; other HTTP errors and explicit
upstream rejection use `upstream_rejected`, and network failures use
`transport_failed`. Verification retains the common authentication error codes.

`subscriberCount()` accepts nonnegative safe integers or trimmed decimal digit
strings, including zero. Missing, negative, fractional, unsafe, or other count
values fail as `invalid_response`. A successful count is cached for that Group
object's lifetime with no expiry; zero is cacheable. A cache hit makes no network
or storage call and does not reverify authentication. `{ force: true }` verifies
and fetches again. A failed refresh throws and retains the last successful cached
value for later ordinary reads; failed initial reads are never cached. A fresh
`groups()` result has fresh count caches. Obtain fresh groups or force refresh
when current authorization/counts matter, including after a session reset.

`groups`, `everyoneGroup`, and `subscriberCount` accept `{ signal }`. Each network
operation shares one coordination lock, deadline and transient GET retry budget
across verification, recovery and all its endpoint reads. Cancellation also rejects
an already-aborted cache read. These methods reuse `user/userData` verification;
other endpoint bodies never introduce additional session-expiry heuristics.
Verified session rotations are saved before later discovery/count reads, even if
those reads fail. Cookies from those later responses are saved only after their
group/count validation succeeds. No adapter,
AI client, browser runtime, or live credentials are required by these APIs.

</details>

### Add a member

```typescript
await client.addMember("101", {
  firstName: "Alex",
  lastName: "Rivera",
  email: "alex@example.test",
  // Or mobilePhone: "+1 (202) 555-0123", or both.
}); // { success: true }
```

Provide first and last names and at least one contact method. The client checks
the session before submitting and returns only confirmed success. A submitted
write is never automatically repeated; preserve an error's `outcome` in adapters.

<details>
<summary>Member inputs, failures, and retry limits</summary>

`addMember(groupId, member, { signal })` uses the same group-ID normalization as
discovery. Names and contact fields are trimmed; optional `null`, `undefined`,
and blank contact fields become empty form values. Email needs a nonblank address
with one `@` and a dotted domain. Mobile numbers accept digits, spaces, `+` at the
start, parentheses, hyphens, and periods, with 7–15 digits. Invalid inputs use
`invalid_input` / `not_submitted` before storage or network access. Keep member
inputs and transport request bodies out of logs.

One coordinated deadline covers verification, any bounded password recovery, and
the membership POST. Verified cookie rotations are saved before submission.
The request sends `fname`, `lname`, `email`, and `mobile_phone`; there is no
separate create/update branch or automatic identity editing. Only an object with
`success: true` yields `{ success: true }`; upstream person/contact details are
discarded. A false result uses `upstream_rejected`, unavailable groups retain
their HTTP error status (for example 404), permission denial uses
`permission_denied`, and malformed success responses use `invalid_response`.

Before membership submission, errors have `outcome: "not_submitted"`. After
possible submission, rejection, timeout, connection loss, cancellation, or failed
cookie persistence keeps `outcome: "unknown"`. Even an auth-like POST response
doesn't prove the write was unexecuted, so it never triggers replay. The shared
write-outcome rules below also apply. Existing Group count caches aren't changed;
force refresh or rediscover groups when current counts matter.

Repeated-add, existing-member matching, duplicate, and notification effects still
need controlled test-parish verification before any operation-specific replay is
enabled. There is no idempotency guarantee, deduplication store, or background
queue, and routine tests never make live membership writes.

</details>

### Requests and storage

`get(path)` returns JSON or text. `post(path, fields)` sends URL-encoded string
fields. Use paths like `user/userData`, not full URLs or query strings. Requests
stay on the configured parish's HTTPS origin, and redirects are rejected.
Failures throw `FlockbotError` with a safe `code`, without copying sensitive
upstream bodies or exception details.

<details>
<summary>Adapter storage and coordination</summary>

`SessionStore` provides `revision`, `load`, `save(state, expectedRevision)`, and
`clear(expectedRevision)`. Under identity coordination, `revision` and `load`
must read the same current durable generation. `save` and `clear` must atomically
compare the expected revision and advance it on success, including clearing an
already-empty store. Revisions must never be reused. A stale comparison must
throw `FlockbotError("stale_session_state")`. Save and clear failures use sanitized
`session_save_failed` and `session_clear_failed` errors; load/revision failures use
`session_load_failed`. Persist session and intervention state together.

`SessionCoordinator.runExclusive(identity, signal, work)` must serialize **all**
operations, cookie writes and resets for that connection across invocations and
restarts. The supplied identity is the parish origin; scope the coordinator and
store to the same protected login/connection namespace. State is reloaded after
acquiring coordination. All writers, including administrative token imports, must
follow this contract. A process-local mutex is insufficient for a distributed
adapter. Use durable fencing to prevent an expired lease holder from publishing
state, and do not release a running callback until its work settles. CAS storage
is an additional stale-write guard, not a replacement for login coordination.
There is no fallback lock or uncoordinated login when coordination fails.

Unchanged cookies need no save. Cookie replacements on successful requests and
rejected redirects are persisted; redirects are never followed. HTTP errors,
recognized authentication rejection, malformed responses and failed verification
cannot publish replacement cookies. A failed operation is never replayed merely
to retry a save. `clearSession()` advances durable state under the same lock, so
other clients reload the reset and discard older pending rotations.

</details>

<details>
<summary>Deadlines, retries, and cancellation</summary>

Each operation has one deadline covering lock wait, storage, login, transport and
backoff. Defaults are 20 seconds, one transient GET retry across the entire
operation, and 200 ms initial exponential backoff. Configure `policy` with
`timeoutMs`, `maxReadRetries` (0–5), and `readBackoffMs`; inject `clock` for tests.
Only network failures, HTTP 429 and HTTP 5xx on GET are retried. Password POSTs
never retry. Adapters must configure and measure this budget within their host's
confirmed execution limit, including response overhead. No hosted adapter or real
runtime budget has been proven yet.

Pass `{ signal }` to `get`, `post`, `connect`, or `clearSession` to cancel. The
default transport passes the signal to fetch, including body reading. Custom
transports must use only the supplied URL, honor manual redirects and abort.
Coordinators must reject cancelled queued work without running it. A deadline or
cancellation returns promptly even if an injected dependency ignores abort, but
cannot undo a submitted request or storage write. Coordination must remain held
until that dependency settles; subsequent signal checks prevent new requests or
cookie saves. Storage calls already in progress may finish before a queued reset.
Adapters must bound their own storage and lock lifetimes and fence late holders.

</details>

Submitted writes aren't replayed automatically. A timeout can leave completion
unknown; preserve that outcome when mapping host retries.

<details>
<summary>Write outcomes and retry safety</summary>

`operation_timeout`, `operation_cancelled`, and `coordination_failed` are sanitized
failures. Unclassified callback failures on reads use `operation_failed`.
For POST, an error before submission has `outcome: "not_submitted"`.
A transport may throw `RequestNotSentError` only when it guarantees no request was
submitted; it becomes `request_not_sent`. After submission, a transport error,
timeout, cancellation, rejected response or persistence failure keeps its sanitized
error code and HTTP status, with `outcome: "unknown"`. Unclassified failures use
`write_outcome_unknown`. The outcome stays unknown even for an explicit rejection;
the response alone doesn't prove that no side effect occurred. No public POST is
replayed or renewed after submission. Operation-specific verification/replay
requires separate evidence of safety; generic POST provides no replay opt-in. Adapters must preserve
this outcome when mapping host retries. A successful POST response is returned
only after its required cookie persistence succeeds.

</details>

### Private Zapier authentication candidate

`npm run check` also builds, packages, and tests the private [Zapier adapter](adapters/zapier/README.md).
It reuses this client and protected connection fields. It has no actions and keeps
operational writes disabled while durable persistence and coordination are unverified.

Tests use fictional data and block unexpected network access. They don't need
credentials, environment files, or live Flocknote access, and never record missing
fixtures. CI runs checks without live credentials, deployment, or publishing.

## Ruby gem

<details>
<summary>Legacy Ruby installation, usage, and development</summary>

Requires Ruby 3.3. Add this to your `Gemfile`:

```ruby
gem "flockbot", git: "https://github.com/askmyparish/flockbot"
```

### Connect

Create a session, choose a login method, then create the client. The subdomain
is the first part of your Flocknote URL.

```ruby
session = Flockbot::Session.new(subdomain: "example-parish", email: "user@example.com")

# Choose one:
session.login!(password: "example-password")

# Or request a code:
session.send_one_time_code
session.login!(code: "1234")

# Or reuse a saved session:
session.login!(token: saved_token)

client = Flockbot::Client.new(session: session)
```

### Groups and members

```ruby
client.groups
client.everyone_group
client.groups.first.subscriber_count
```

Adding a member requires first and last names, plus an email, mobile number,
or both. New members also join Everyone. Existing members are matched by email
or phone; the supplied name doesn't rename them.

```ruby
group = client.groups.last

group.add_user(first_name: "Alex", last_name: "Rivera", email: "alex@example.com")
group.add_user(first_name: "Sam", last_name: "Lee", mobile_phone: "555-555-5555")
```

### Ruby development

Use `bundle install` and `bundle exec rspec`. `bin/console` still opens a Ruby/Pry
prompt; `bin/setup` and `bin/test` now serve TypeScript.

</details>

## Contributing

Issues and pull requests are welcome at
[askmyparish/flockbot](https://github.com/askmyparish/flockbot).

## License

Available under the [MIT License](https://opensource.org/licenses/MIT).
