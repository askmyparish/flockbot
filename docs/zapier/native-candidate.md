# Native Session Auth candidate

This separate private candidate targets lightly used workflows using Zapier's
Session Auth and an auth-scoped membership action lock. The default package
retains its write block. This candidate is prepared for controlled verification;
building it does not upload, publish, migrate Zaps, or authorize live writes.

On Node 22, run `node scripts/zapier/build-native-candidate.mjs`. The command
prints a temporary directory containing a private 2.1.4 package with a root
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
membership POST, under one 20-second budget with no transient read retries.
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

Only confirmed upstream success returns `{success:true}`. Every failure after
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

The selected response details are `success`, `authorized`, `error` (falling back
to `message`), `userId` (from `userID`), and `existingSubscription`. Error text is
limited to 1,024 characters, with `errorTruncated:true` when shortened. Current
and response cookie values are redacted, credential-related wording is withheld,
and HTML/control characters are removed. These reports intentionally contain
member contact data; use deployment log access and retention appropriate for it.
No error reason is inferred from an address or from words in the response.
Addresses are never rewritten and no plus-sign prohibition is added.

JSON error wording is preserved for HTTP 4xx/5xx responses as well as 2xx
`success:false` responses. Malformed or non-JSON HTTP error bodies retain their
HTTP classification without being copied into the report. Returned user IDs and
subscription flags are diagnostic facts, not evidence that a member was created
or a membership succeeded. Every submitted failure still has unknown completion.

The halted error includes the attempted contact, group, upstream wording or fixed
code, HTTP status when available, and attempt ID. Reporting never changes the
write outcome or triggers a member retry, even if console logging throws. The
console event supports investigation; it does not itself send a notification or
configure an external error tracker. HTTP logging remains disabled.

To inspect these records, run
`zapier-platform logs --type console --status any --version 2.1.4` from the linked
artifact directory and look for `flockbot.membership_failed`. Include all statuses
because the action uses a halted outcome. The attempt ID connects the console
record with the user-facing error.

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
