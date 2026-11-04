# Read-only host capability probe

This separate private candidate has no membership action. It observes native
operation locking and saved-session reuse without using Storage, reading a
password, requesting refresh, or proving production readiness. Reuse an existing
test-only connection; authentication setup/refresh and connection tests refuse
without contacting Flocknote. Use the explicit saved-session action to verify it.

On Node22, run `node scripts/zapier/build-host-probe.mjs --private-plan-file <private-file>`.
The private owner-readable JSON file contains only:

```json
{
  "consent": "authorize-read-only-host-probe-build",
  "subdomain": "example-parish",
  "networkId": "201",
  "testOnlyLoginConfirmed": true
}
```

The build creates a separate private 2.0.2 package with a 30-minute window and
root CommonJS entry. Inspect build/source ZIPs and load the extracted hosted
wrapper before an authorized upload. Never include deploy keys or private input
files. The normal integration's membership blockade stays intact.

The controlled procedure is two concurrent hosted `lock_hold` calls, labeled
`A` and `B`, then two sequential hosted `verify_saved_session` calls. Each call
requires consent `authorize-read-only-host-probe`. Use the same existing test
connection for all four. Do not create or reconnect an account for the probe.

`lock_hold` has native `operation.lock` with a fixed key, `auth` scope and
5-second timeout. It holds for 3 seconds and makes zero Flocknote requests.
Returned timestamps and monotonic duration are observations. Comparing intervals
across machines assumes comparable clocks; non-overlap alone proves no lock
guarantee, release semantics, refresh coverage or fencing. A timeout/unknown
invocation stops the test; do not automatically repeat it.
The remote-invoke path may differ from live Zap task scheduling. Establish
whether that path applies the native lock before drawing conclusions about
production runs; an overlap could also mean this test path bypasses locking.
Cold-start delay could also consume the lock's five-second hold before the
action starts, depending on when the platform acquires it. No warm-up or repeat
is included in this trial, so overlap does not identify that timing behavior.

`verify_saved_session` loads only the host-supplied saved session, verifies
authentication on `user/userData`, then compares `network/getMetadata.networkID`
with private configuration. It allows at most two GETs in 20 seconds, bounded
also by expiry, with no retries, credential provider or refresh error. Wrong
origin, missing/rejected state and unknown identity fail closed. Output is only
connection status, request count, zero password reads and whether this local jar
observed a cookie-state change, including expiry changes rather than only a
changed token. Local cookie updates do not prove host write-back; the
result always says `normalActionPersistenceProven: false`.

Use the existing CLI remote-invoke interface and record minimal results, not
authentication bundles or HTTP logs. No member data, cookie values or
fingerprints are returned. This procedure authorizes no member add, account
reset, production migration or rollout. Delete private staging/configuration and
retire the temporary version after the controlled session.
