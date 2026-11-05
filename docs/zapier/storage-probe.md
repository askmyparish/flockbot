# Try Zapier Storage safely

This experiment checks Storage by Zapier's conditional updates using random,
nonsecret markers. It makes no Flocknote requests and does not enable member
additions. It is separate from the SDK's `z.cache`.

Use Node.js 22.13+ and run `bin/setup`. The default command is inert:

```sh
node scripts/zapier/probe-storage.mjs
```

After reviewing the runner, create a **dedicated empty Storage by Zapier
connection**. Supply its UUID4 store secret in an owner-only file outside this
checkout (mode `0600`). Never use an existing workflow's store, put the secret
in command arguments, or paste it into logs/chat.

```sh
node scripts/zapier/probe-storage.mjs \
  --authorize-isolated-storage-probe --dedicated-store \
  --secret-file /path/to/private-storage-secret
```

The runner reads only that explicit file and builds its TypeScript entry into a
temporary directory. It does not load environment files or saved app connections.
Delete the private secret file after the approved test session.

The probe uses one fresh random key, with up to 14 requests total: keyed reads,
conditional creation, refusal of a null-previous overwrite, two competing updates,
a stale update and cleanup. It never lists or clears the store. Requests use the fixed Storage HTTPS
origin, header authentication, manual redirects and no retries. Each request is
limited to two seconds; the main experiment has 15 seconds plus at most two
seconds for cleanup. The ordinary success path uses 12 requests.

Results contain check booleans, numeric HTTP statuses/fixed error codes per step,
cleanup status, request count and elapsed time. `unresolvedWrites` counts mutations
whose marker hasn't been read and which haven't received the expected HTTP400
rejection. This includes acknowledged 2xx writes: an acknowledgement alone is not
proof the change finished. A failed or lost mutation acknowledgement is never
repeated. Cleanup checks that the random key contains this run's marker,
deletes only that key, then confirms absence. Failed or uncertain cleanup is
reported as `unconfirmed`. An uncertain mutation is reconciled only by observing
its unique marker; otherwise cleanup stays unconfirmed even after deletion and
an absent read. This does not assume the service's conditional writes work. A
collision or failed initial read permits no cleanup. If cleanup stays unconfirmed,
retire that dedicated test store; do not reuse it for sessions or production data.
This cleanup sequence assumes the dedicated store has no other writers; it is
not an owner-conditional production lock release.

The candidate expects GET to return either an empty object or an object containing
only the requested key, with a null value also meaning absent. The inferred PATCH
body is `{"action":"set_value_if","data":{"key":...,"value":...,"previous_value":...}}`;
these field names follow the StoreClient arguments and are not established by the
REST page's example. It expects null previous value to permit creation only when
absent, and comparison failure to return HTTP400. Any HTTP400 is treated as a
possible mismatch without reading its body, so an unrelated 400 remains a limit.
A different wire contract fails this experiment and needs investigation.
A 2xx mutation response alone never proves a comparison
succeeded. The offline model exercises these assumptions; it does not establish
the real service contract.

## What a pass means

A pass supports the tested conditional creation, contention, stale-update and
reload behavior on that run. A single contention trial does not establish that
requests overlapped on the server or prove atomicity: connection setup may skew
their arrival. Results therefore always include `atomicityProven: false`.
The probe does not prove indefinite durability, a complete distributed coordinator,
lease fencing, encrypted session storage, runtime
performance from a deployed integration, or safe membership writes. Those need
separate implementation and hosted tests before removing the current write block.

The docs disagree on inactivity expiry (two versus three months) and value size
(REST landing page says 2,500 bytes; help says 1 MB). This probe uses short markers
below the smaller limit. Long idle periods and missing state need a deliberate
reconnect policy before storing sessions here.

Routine checks remain offline: `bin/test test/zapier/storage.test.ts` and
`npm run check`. Do not add this live command to CI.

Sources: [Storage REST API](https://store.zapier.com/),
[StoreClient conditional operations](https://help.zapier.com/hc/en-us/articles/8496293969549-Store-data-from-code-steps-with-StoreClient),
[Storage limits](https://help.zapier.com/hc/en-us/articles/8496293271053-Save-and-retrieve-data-from-Zap-workflows-using-Storage-by-Zapier).

<details>
<summary>Optional validation diagnostic after a rejected probe</summary>

After separate authorization, replace the consent flag with
`--authorize-isolated-storage-diagnostic` to inspect one rejected request's
validation hints. Use the quarantined test store and the same private-file gate.
It creates a new random key and sends one PATCH with the candidate null-previous
body, followed by at most three keyed cleanup requests. The bound is four requests,
two seconds each, eight seconds total; no retries or POST initialization.

Only fixed allowlisted field/type names, boolean hints and numeric statuses are
returned. The error body is limited to 16 KiB in memory and is never returned,
logged or saved. These hints can indicate a request-schema problem; they do not
prove the service accepts conditional creation or updates. A received HTTP400
means the diagnostic completed, not that conditional updates passed. Timeout or
transport failure stops immediately, with cleanup unconfirmed. A missing key or
foreign marker permits no deletion. This does not test Flocknote or enable writes.

</details>

<details>
<summary>Initialized-record experiment</summary>

The separately authorized `--authorize-initialized-storage-probe` mode uses the
same wrapper and private-file options. It checks a fresh random key is absent,
creates one harmless string with POST, verifies it, then tests string-to-string
contenders, stale rejection and reload. Cleanup deletes only an observed marker
owned by this run. Maximum 14 requests, 15 seconds plus 2 seconds for cleanup,
no retries. Unknown POST/PATCH completion remains unresolved until observed.

This does not test conditional creation on missing keys or prove atomicity.
Production provisioning would need its own protected one-time process; missing
session state must never trigger unconditional recreation. No Flocknote calls
or shipped membership changes are involved.

</details>

Initialized POST uses `{ "<fresh-key>": "<nonsecret-marker>" }`. The normal
success sequence uses 11 requests. Only PATCH HTTP 400 is treated as a definite
comparison rejection; a POST 400 remains unresolved. The initialized tests are
in `test/zapier/storage-initialized.test.ts`.

The separately approved `--authorize-storage-comparison-diagnostic` wrapper mode
creates one fresh harmless record, reads it, tries a matching string update,
reads it, then tries a deliberately stale update and reads again. It reports
only fixed field names, booleans, status codes and whether returned values match
known markers. PATCH response inspection is capped at 16 KiB inside each request's
2-second deadline. At most 10 requests, 15 seconds plus 2 seconds for cleanup,
no retries. Cleanup targets only observed owned markers. An unobserved stale
write stays unresolved even if a body says false: body semantics are being
investigated, so cleanup can remain unconfirmed. There is no CAS pass claim or
Flocknote access. All secret-file gates are shared with the other modes.

Comparison-mode exit 0 means the sequence completed, even if the stale write
overwrote the record. HTTP rejection still permits a readback; transport failure
stops the main sequence. Readbacks, rather than response hints, establish the
observed matching/stale behavior. Hints inspect only top-level fields. A correct
stale refusal always leaves its unseen attempted marker unresolved, so cleanup
remains unconfirmed and the dedicated store must stay quarantined/retired.

<details>
<summary>Contender-response diagnostic</summary>

The separate `--authorize-storage-contention-diagnostic` flag uses the same
private-file and dedicated-store gates. It creates and reads one fresh string
record, sends two conditional PATCH requests with the same previous value,
reads the winner, then tries a stale update and reads again. It records a fixed
stage name for each contender response, so response completion order cannot
mislabel the evidence. Bodies use the same bounded boolean-only projection.

Maximum 11 requests, 15 seconds plus 2 seconds for owned-marker cleanup, 2 seconds
per request and no retries. A transport failure or timeout stops the main
sequence after both contenders settle; it does not replay either request. No
Flocknote, cookie, session, member or integration-deployment work is involved.
If no contender value is observed, the main sequence stops with
`storage_protocol_error` before the stale PATCH, preserving the response evidence.

`singleWinnerObserved` requires one 2xx, one HTTP400 and a readback matching the
successful contender. Other status conventions remain unverified. `winnerIsA`
and `winnerIsB` describe that readback; `matchingApplied` means a known contender
value was observed. `clientOverlapObserved` records overlapping client requests,
including body inspection, and proves no server-side overlap. Responses remain
diagnostic hints, not commit acknowledgments. Exit0 means only that the sequence
completed. There is no `passed` claim, and `atomicityProven` stays false even
when one winner is observed. One contradictory run can expose an unusable
contract; repeated positive runs cannot establish supported atomicity or fencing.

Every attempted marker stays unresolved until read back, including rejected
contenders and the stale attempt. Thus a normal refusal leaves cleanup
unconfirmed even after an owned DELETE and an absent read. Keep the experimental
store quarantined; use only fresh keys there and never store sessions in it.

</details>
