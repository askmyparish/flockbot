# Private Zapier authentication candidate

This package reuses the shared TypeScript client for Session Auth. It is an
offline development candidate, with no registered triggers, searches, or actions.
Operational writes stay disabled. Nothing here deploys or replaces an existing
private integration.

From the repository root, use Node.js 22.12+ and npm:

```sh
bin/setup               # Locked workspace dependencies, no install scripts
npm run check           # Core and adapter types/tests/build/package checks
npm run build:zapier    # Bundle the shared client into a CommonJS entry
npm pack --workspace @askmyparish/flockbot-zapier --ignore-scripts --pack-destination /tmp
```

The npm tarball is a local development artifact. It is **not** a Zapier deployment
ZIP. Uploading, registering, or deploying an integration is a separate step. The
pinned SDK is `zapier-platform-core` 19.3.0; the bundle targets Zapier's documented
Node.js 22 runtime. Installation requires registry access; routine tests do not.

## Connection flow

The connection asks for the parish subdomain, Flocknote email, and password in
protected authentication fields. It never asks action inputs or URLs to carry
credentials. `sessionData` is a protected computed password field. The adapter
uses a fixed internal configuration generation until a durable host reset and
credential-change mechanism is established; users don't enter that detail.

`sessionConfig.perform` calls the shared password-login lifecycle, verifies it,
then returns only serialized allowed session data. That successful return is the
supported host persistence boundary. Original connection credentials remain
host-owned auth fields; they aren't copied into the serialized session. The hook
supports initial auth fields in `inputData` and existing connection fields in
`authData` during renewal. A connection test returns only `{ connected: true }`.

One read execution owns one client, cookie jar, local store, and local queue.
Cookie replacements are available to later reads in that execution. The wrapper
does **not** claim that changing `bundle.authData` or that local store updates the
saved Zapier connection. A fresh execution starts with the last host-supplied
`sessionData`.

For saved sessions, only the shared lifecycle's request for renewal after an
absent saved session, expired/missing cookie, or confirmed invalid `user/userData` response becomes
`RefreshAuthError`. The auth hook then performs one password exchange. Permission
denial, HTTP 401/429/5xx, malformed responses, and unknown failures don't trigger
refresh. Rejected passwords and interactive challenges become `ExpiredAuthError`
for manual reconnect. If a fresh password exchange succeeds but its session
verification is rejected, the hook reports `authentication_required` as a normal
error; it doesn't mark that as an intervention requiring disconnection. Nonempty
malformed saved session payloads fail clearly instead of requesting refresh.
The client never requests or submits a code.

Requests use the shared native-fetch transport, not `z.request`. This avoids
`z.request`'s automatic 401 refresh/whole-step replay and early 429 retry path.
`skipHttpPatch: true` also disables SDK HTTP patching. There are no request/body
logging hooks. Whole-host telemetry redaction still needs controlled verification.
Keep raw bundles, serialized auth results, and request bodies out of logs. Auth
results redact Node inspection, but JSON intentionally contains the cookie for
protected host storage.

## Feasibility gate

The reviewed Session Auth docs establish persistence of a successful auth-hook
return. They do not establish ordinary-action cookie write-back, an atomic
per-connection compare-and-swap store, or a cross-invocation renewal lock. This is
an unverified guarantee, not a claim that Zapier cannot provide it.

To meet the shared core contract, a host must serialize all connection operations,
cookie writes and resets across invocations/restarts, reload current state under
that coordination, and atomically advance never-reused revisions. Lease fencing
must stop expired holders from publishing; cancellation cannot release a running
callback early. Session and intervention state must remain durable together.
A process-local queue and local revision counter satisfy none of those cross-run
guarantees. Failed auth hooks also cannot commit an intervention record through
the successful-return hook; the actual manual-reconnect/disconnection behavior
must be verified.

The exported source-level `runOperationalWrite` refuses before invoking its
callback, and the packaged app registers no write action. The read execution
exposes no `post`, `addMember`, or unrestricted core client. No write readiness
switch is provided. Establish supported host capabilities and run controlled
platform tests before adding operational writes or selecting a hosting fallback.

| Contract | Offline evidence | Real-host status |
| --- | --- | --- |
| Login and allowed session return | Shared exchange and SDK hook tests | Persistence acknowledgment still to verify |
| Reload after auth renewal | Explicit modeled-host commit; next invocation sends replacement | Verify refresh result visibility in deployed runtime |
| Same-execution rotation | Later read sends updated cookie without logging it | Normal-action durable update unestablished |
| Rejection/challenge | Fixed manual-reconnect error; modeled durable intervention stays blocked | Verify host disconnect and later-run suppression |
| Store failures | Injected core-store errors fail closed | Host persistence acknowledgment/failure remains unverified; no invented save API |
| Coordination | Local queue only; write callback blocked | Cross-run lock/CAS/fencing unestablished |
| Packaging | SDK schema, actual tarball import, mocked default transport | No upload/deployment/runtime-budget proof |

The injected store/coordinator/transport parameters are test seams, not Zapier
APIs. Tests deliberately separate their simulated persistence from host facts.
The default 20-second client deadline leaves nominal room inside the documented
30-second ordinary action limit, but measured login/read/refresh budgets and the
actual Zap's retries and notifications are still required before cutover.

Adapter and test type checks keep strict checking of repository code. They use
`skipLibCheck` for the SDK's generated declarations, which conflict with
`exactOptionalPropertyTypes`; the standalone core type check stays unchanged.

## Primary references

- [CLI Session Auth and stale credentials](https://docs.zapier.com/integrations/build-cli/overview)
- [Request middleware order and logging](https://docs.zapier.com/integrations/build-cli/making-http-requests)
- [Runtime operating constraints](https://docs.zapier.com/integrations/build/operating-constraints)
- [SDK schemas and implementation](https://github.com/zapier/zapier-platform)

These sources and the installed pinned SDK were checked during development.
Documentation is evidence for the stated hooks, not proof of unmentioned host
persistence or coordination guarantees.
