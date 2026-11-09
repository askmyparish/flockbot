# Native Session Auth candidate

This separate private candidate targets lightly used workflows using Zapier's
Session Auth and an auth-scoped membership action lock. The default package
retains its write block. This candidate is prepared for controlled verification;
building it does not upload, publish, migrate Zaps, or authorize live writes.

On Node 22, run `node scripts/zapier/build-native-candidate.mjs`. The command
prints a temporary directory containing a private 2.1.6 package with a root
CommonJS entry. Run `npm run check` for offline verification. Inspect the actual
CLI ZIPs and hosted loader before any separately authorized upload.

For CLI packaging, install `zapier-platform-cli@19.3.0` on Node 22. In the printed
artifact directory, install its pinned SDK dependencies and link the intended
integration. Linking requires a private CLI login and writes app identity metadata
to `.zapierapprc`; keep the deploy key outside this directory.

```sh
cd <printed-artifact-directory>
npm install --package-lock-only --ignore-scripts
npm ci --ignore-scripts
zapier-platform link
zapier-platform build --skip-dep-install --skip-validation
unzip -Z1 build/build.zip
unzip -Z1 build/source.zip
```

This offline build deliberately skips platform validation; it does not establish
upload readiness. For an authorized hosted checkpoint, run the build again
without `--skip-validation` to send the definition to Zapier for validation.
Audit both ZIPs for credentials and private inputs. The app-link file may contain
only the intended app identity, and dependency URLs must contain no credentials.
Extract `build.zip` into an empty directory, load its root `index.js`, and invoke
the extracted `zapierwrapper.js` handler with
`{command:"definition",calledFromCli:false}`. Confirm the resulting definition
contains the membership action's auth-scoped lock and `skipHttpPatch:true`.

The five membership inputs and group dropdown match the existing integration.
Input validation precedes connection access. Each membership invocation uses one
client and cookie jar for group validation, authentication preflight and one
membership POST, under one 25-second budget with no transient read retries.
This leaves nominal five-second headroom inside Zapier's documented 30-second
action limit for cancellation, reporting and returning the result; it is not a
measured host-runtime guarantee. The shared client default and isolated host
probes retain their separate deadlines.
The operation requests a native lock with a fixed key, auth scope and 60-second
hold. This covers the membership action, not connection tests, the authentication
hook or the group dropdown. Lock timing, refresh coverage and fencing remain
unverified; it is not a durable store/coordinator implementation.

At the hosted checkpoint, record whether a competing action is held, refused or
retried and whether that outcome is visible to the operator. Also check whether
Session Auth's re-execution after `RefreshAuthError` contends with the original
action's 60-second lock. A lock rejection must not be mistaken for a completed
membership add, and an uncertain attempt must not be repeated automatically.

Only the authentication hook reads the protected login credentials and returns
protected `sessionData`. Actions reuse that saved state. Response cookie changes
are local to the invocation and are not returned as an auth update. If an absent
or confirmed-invalid session stops the action before submission, it requests
Session Auth renewal. The hook makes at most one password-login exchange per
execution. The host's refresh/re-execution limits, concurrent refresh handling
and persistence timing still need controlled hosted verification. Generic HTTP
failures, permission denial and transport errors do not request renewal.

Confirmed upstream success returns `{success:true}`. The specific pending-merge
response described below completes with a warning instead. Every other failure after
possible submission uses the existing `HaltedError` mapping and tells the operator
to inspect Flocknote before repeating. The adapter never requests renewal or
replays a submitted membership write. Host autoreplay, user notification and
visibility of halted runs still need verification; the mapping alone does not
prove those host guarantees.

Version 2.1.4 reports unsuccessful membership attempts with one structured
`flockbot.membership_failed` console event. The event contains an attempt ID,
timestamp, app version, parish when known, failure stage, the five action inputs,
error code, completion outcome, and available HTTP status and response details.
Inputs are snapshotted before asynchronous work, trimmed, and bounded to 1,024
characters per field; `inputs_truncated` identifies a shortened snapshot. Extra
input fields, connection auth data, credentials, cookies, and whole bundles are
never copied. Normal Session Auth renewal requests are recovery, not final
failure events; successful writes produce no failure record.

Version 2.1.5 accepts the observed HTTP 200 `success:false` response whose exact
error is `This contact information already exists on a user with a pending merge`
as a business warning. It completes the Zap step with `success:true`,
`status:"pending_merge"`, `membership_confirmed:false`, `warning`, and `attempt_id`.
Here, `success` means the workflow accepted this exception; it does not assert
that this response created or verified a membership. Resolve the merge in
Flocknote and check group membership when needed. No second submission or lookup
is made. An authorization denial, another HTTP status, truncated text, or any
different rejection remains an error. The shared client retains its conservative
rejection classification; this exception belongs to the Zapier workflow.

The accepted exception emits one `flockbot.membership_warning` console event with
the same input and response details and `outcome:"pending_merge"`, rather than a
failure event. A logging failure does not cause a retry.

Phone values are sent as entered after trimming, with the existing basic input
validation. Country codes and punctuation are not rewritten. The input snapshot,
error summary, and submitted form retain that same number. Blank mobile fields
stay empty. Flocknote's response supplies the diagnostic evidence; no phone
formatting rule or contact-conflict cause is inferred.

The selected response details are `success`, `authorized`, `error` (falling back
to `message`), `userId` (from `userID`), and `existingSubscription`. Error text is
limited to 1,024 characters, with `errorTruncated:true` when shortened. Current
and response cookie values are redacted, credential-related wording is withheld,
and HTML/control characters are removed. These reports intentionally contain
member contact data; use deployment log access and retention appropriate for it.
Apart from the exact pending-merge exception above, no error reason is inferred
from an address or from words in the response.
Addresses are never rewritten and no plus-sign prohibition is added.

JSON error wording is preserved for HTTP 4xx/5xx responses as well as 2xx
`success:false` responses. Malformed or non-JSON HTTP error bodies retain their
HTTP classification without being copied into the report. Returned user IDs and
subscription flags are diagnostic facts, not evidence that a member was created
or a membership succeeded. Every submitted failure still has unknown completion.

The halted error includes both attempted email and mobile when supplied, the
group, upstream wording or fixed
code, HTTP status when available, and attempt ID. Reporting never changes the
write outcome or triggers a member retry, even if console logging throws. The
console event supports investigation; it does not itself send a notification or
configure an external error tracker. HTTP logging remains disabled.

To inspect these records, run
`zapier-platform logs --type console --status any --version 2.1.6` from the linked
artifact directory and look for `flockbot.membership_failed`. Include all statuses
because the action uses a halted outcome. The attempt ID connects the console
record with the user-facing error or warning. Pre-submission errors also include
the stage and attempt ID. A `membership` stage can include authentication
preflight before the POST; the completion outcome, rather than the stage alone,
indicates whether submission was possible. A pre-submission timeout remains an
error and does not count as a completed membership.

### Request timing diagnostics

The source now attaches a `diagnostics` object to the existing failure and
pending-merge warning console events. This requires a deployed build containing
the change; it cannot add detail to historical attempts. The same `attempt_id`
links the error to its request timings. One `z.console.log` event is emitted per
failure/warning, not per request; confirmed successes and normal Session Auth
renewal requests remain quiet.

`diagnostics` contains the configured `timeout_ms`, total `elapsed_ms`, and at
most 12 request records, with `requests_truncated` if additional requests were
omitted. Durations use a monotonic clock. Each request records its allowlisted
endpoint name, method, action stage, `started_ms` relative to the attempt,
`elapsed_ms`, and state:

- `responded`: the transport returned the complete response body; `http_status`
  is available. This does not imply application success or valid response data.
- `failed`: the transport threw before returning a complete response.
- `aborted`: the transport threw while its cancellation signal was aborted.
- `in_flight`: the transport had not settled when the report was captured,
  including a stalled response-body read or a dependency ignoring cancellation.

At a deadline, a cancellation-aware transport may appear as either `aborted` or
`in_flight`, depending on whether its rejection reaches the wrapper before the
snapshot. `in_flight` alone does not establish that cancellation was ignored.
An in-flight duration is measured up to the report, not eventual completion.
The transport boundary cannot distinguish DNS, TLS, headers and body-read delays;
a status is unavailable if the complete transport response never returned.
The final error code and write outcome remain authoritative: an in-flight or
aborted membership POST is not evidence that a write was unsubmitted.

Group IDs are replaced with `:groupId` in endpoint names; unrecognized endpoints
become `other`. These new diagnostics contain no origins, queries, headers,
request/response bodies, credentials, contact fields or raw exception messages.
The existing failure report still contains its bounded member inputs and selected
response details, so console output must still be treated as sensitive.

Use the console command above with the version used by the failing Zap. It
defaults to the CLI user's records; use `--user` when investigating another
authorized user's run. Find the attempt ID, inspect the final error/outcome, then
compare completed request durations and the in-flight endpoint. Do not enable
`--debug`, dump bundles, or enable SDK HTTP patching to diagnose timing: those
can expose credentials or bodies. Native fetch, cancellation and no-replay rules
are unchanged. These timings cover the native membership action, not the
separate authentication hook or group dropdown. Host termination before the
failure handler runs can still leave no console record.

The low-traffic tradeoff is to reuse the host-saved cookie without a separate
Storage coordination protocol. Read-only test observations support reuse over
their observed interval, not maximum lifetime or all rotation behavior. Natural
expiry, renewal failure and lost-response behavior remain open. The original
production acceptance requirements have not been waived by this candidate.

No Storage client, Cloudflare service or external session store is included.
Credentials belong only in protected deployment inputs; authorized member inputs
also appear in the structured failure reports described above.
HTTP logging is disabled with `skipHttpPatch`; whole-host telemetry still needs
controlled inspection. Keep public examples fictional and omit raw auth bundles
and HTTP logs from review evidence.

Version 2.1.6 distinguishes a recognized wrong-password response from other
authentication intervention in its connection errors. The former asks the user
to check their password; the latter directs them to resolve authentication in
Flocknote before reconnecting. The authentication exchange and retry rules are
unchanged, and unknown failures are not labeled wrong passwords.
