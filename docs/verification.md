# Verification and cutover

The private candidate is ready for offline checks. **Hosted feasibility is still
blocked**, and its packaged membership action refuses writes. This kit prepares
a later authorized run; it doesn't deploy an integration or contact Flocknote.

| Stage | What it can establish | What it can't establish |
| --- | --- | --- |
| Offline | Shared-client behavior, guard order, SDK schema, tarball contents and modeled actions | Real credentials, network identity, Zapier durability or delivery |
| Hosted candidate | Actual CLI build, protected auth persistence, coordination, runtime and telemetry | Production compatibility or permission to cut over |
| Test parish | Real login/session behavior and bounded fictional membership effects | A general idempotency or notification guarantee |
| Production cutover | Existing Zap mappings, notifications and one controlled real workflow run | Permission to retire the old service before rollback is proven |

## Build the private candidate

From the repository root on Node.js 22.12+:

```sh
bin/setup
npm run check
bin/test test/verification-guard.test.ts
candidate_dir="$(mktemp -d)"
npm pack --workspace @askmyparish/flockbot-zapier --ignore-scripts --offline --cache "$candidate_dir/npm-cache" --pack-destination "$candidate_dir"
```

Installation needs npm registry access. Tests and packaging use no live-service
credentials. Keep the reviewed commit, Node/SDK versions and check summary with
the artifact. The tarball contains `package.json`, `README.md` and the bundled
`dist/index.cjs`; it isn't a deployment ZIP. The package check extracts that
tarball, supplies the installed locked SDK, validates it and exercises it offline.
Its separate disposable model bundle never becomes the shipped entry.

<details>
<summary>Later CLI packaging and private deployment procedure</summary>

These steps are **pending verification**, not part of `npm run check`. No CLI
build, upload or hosted run is claimed. Use a separate temporary directory and a
new private test integration; never link this candidate to an existing deployed
integration. The CLI is deliberately not installed globally or added to routine
tests. CLI 19 uses `zapier-platform`; the old `zapier` binary was removed.

After the operator approves this separate platform stage, extract the candidate:

```sh
tar -xzf "$candidate_dir/askmyparish-flockbot-zapier-0.0.0.tgz" -C "$candidate_dir"
cd "$candidate_dir/package"
npm install --omit=dev --ignore-scripts
npm exec --yes --package=zapier-platform-cli@19.3.0 -- zapier-platform build
```

Review and retain the new staging lockfile: the development tarball doesn't
carry the repository workspace lock. Confirm Node 22, SDK 19.3.0, the `.cjs` main
inside this ESM package, dependency inclusion, generated schema and private write
block all work in the real CLI. Its documented output is `build/build.zip` plus
`build/source.zip`. A CLI build may contact platform services; it isn't labeled
an offline test. Failure here blocks upload until resolved.

Only after separate deployment authorization, use the CLI's secure login prompt
and register a new private integration in that staging directory:

```sh
npm exec --yes --package=zapier-platform-cli@19.3.0 -- zapier-platform login
npm exec --yes --package=zapier-platform-cli@19.3.0 -- zapier-platform register "Flockbot verification candidate" --audience private
npm exec --yes --package=zapier-platform-cli@19.3.0 -- zapier-platform upload
```

Review the linked integration before upload. Keep the generated `.zapierapprc`,
deploy key, staging configuration and test connection private and outside this
repository. Don't promote, publish, migrate users or edit the running Zap. This
deploys the blocked candidate only. Proving host capabilities may require a
separately reviewed instrumented prototype or documented platform support; there
is no configuration switch here that unlocks membership writes.

[CLI commands](https://github.com/zapier/zapier-platform/blob/main/packages/cli/docs/cli.md)
define build/register/upload; the [CLI guide](https://docs.zapier.com/integrations/build-cli/overview)
describes the Node 22 runtime and private versions. Their documented procedures
do not prove this workspace's deployment compatibility.

</details>

## Authorize one isolated run

Before any live access, the operator privately records the exact candidate
version, test network subdomain and network ID, dedicated test-only login,
allowlisted test group IDs, controlled fictional member, operation and write
budget. Confirm that login exists **and has access only to the test network**.
An existing test parish doesn't establish that restriction or authorize a run.

Copy [the inert configuration example](../scripts/verification-config.example.json)
outside the checkout. Replace its placeholders only in private configuration.
It contains no credentials and defaults to no consent. Supply credentials later
through protected Zapier connection fields or an approved local secret-store
prompt/file descriptor. Never put passwords, cookies, codes, deploy keys or
contact details in chat, CLI arguments, raw bundles or logs. Keep private config
and session files access-restricted, outside versioned files, and delete them
when the approved session ends. Don't search for existing secret files.

The source-only [guard](../scripts/verification-guard.ts) takes an explicit request
and an injected execution. It has no default runner, credential loader, HTTP
transport, environment-file discovery or live npm command. Its tests use fictional
executions. To run live later, review the concrete runner and invocation first;
that runner must use the shared client and the **same authenticated connection**
for identification and subsequent work. It must keep requests bounded by the
approved deadline and return only minimal confirmation.

The initial allowed operation types are:

1. **Identify only until confirmed.** After explicit consent, allow bounded
   password/session setup and read-only identification on the exact configured
   HTTPS parish origin. Confirm the authenticated session and network ID against
   independent operator-held test-network details. An authorized identification
   read is the sole exception to the no-request-before-confirmation rule.
2. **Read groups/counts.** After identity confirmation, discover the allowlisted
   group and optionally read its count and Everyone's count. No member export or
   contact-record read is allowed. The guard's `read-groups` operation performs
   one group listing and never calls `addMember`; counts are a later runner step
   that must be included explicitly in its approved plan.
3. **One email-only member addition.** Select an existing allowlisted test group
   and one controlled fictional record. New membership can also affect Everyone;
   include that expected effect in the private plan. No messaging, mobile-number
   addition, bulk operation or automatic cleanup/delete is included. A repeat is
   a separately authorized attempt only after the first write is confirmed and
   its effects inspected; never retry an unknown completion.

The proof matrix below also needs separately authorized experiments: invalidating
only isolated saved test-session state; establishing a second test session and
overlapping test invocations; one controlled rejected-password attempt or
observation of a real code challenge; and response-loss injection for one approved
test write. Each needs its own bounded operation list and reviewed runner before
execution. These aren't enabled by the initial guard, and the matrix grants no
permission to run them. Never request, retrieve or submit a code, or repeat an
unknown write.

The guard requires consent `authorize-isolated-test-parish-run`, a confirmed
test-only-login prerequisite, the expected network, a nonempty group allowlist
and a selected allowlisted group. Adds also require a reviewed fictional-record
confirmation and valid email-only member input. It snapshots these values before
awaiting evidence. These configuration confirmations are operator attestations,
**not proof of identity or host readiness**.

There is currently no verified parser for a live network-identity response in
this kit. `user/userData` proves authentication only, and `everyoneGroupID` isn't
a network ID. The later identification step must establish the real supported
shape with read-only evidence; it must return no confirmation until the exact
origin and network ID can be verified. Never echo configured IDs back as observed
evidence, infer identity from a display name, or guess an undocumented endpoint.
Missing, mismatched or unconfirmed identity stops before listing or writing.

Absent consent/config, an unconfirmed login prerequisite or a non-allowlisted
selection stops before **any** execution callback. After authorized identification,
failed/unconfirmed evidence permits no later request; a failed group read or
missing selected group permits no write. The guard allows one add attempt and
returns success only on confirmation. Failures preserve a known `not_submitted`
outcome from the core; otherwise write completion stays `unknown`. The guard
doesn't add retries and isn't a security boundary against an untrusted injected
runner. No fixtures are recorded automatically.

## Fresh proof and direct-host decision

Use a private result sheet with each scenario's candidate/version, method,
expected result, safe observation, elapsed time and pass/fail/unverified verdict.
Record counters and equality booleans instead of tokens, raw bodies or contacts.
No cookie fingerprints or secret-derived identifiers are needed. Inspect raw
host telemetry privately for redaction, then record only the sanitized result.
Any credential, session or contact-data leak stops the run and blocks cutover
until the exposure is contained and redaction is verified.

| Scenario | Required fresh observation |
| --- | --- |
| Saved session | A second independent invocation and a redeployed/restarted candidate send an accepted saved session with zero password reads/exchanges |
| Auth-hook persistence | The supported successful-return hook acknowledges durable save; establish merge versus replacement and preservation of protected credentials |
| Rotation | An actual issued replacement survives normal-action completion, connection testing and a later invocation; older cached/pending state cannot overwrite it. If no rotation occurs, mark this unverified |
| Rejected session | A controlled invalid saved session renews once, saves only verified cookies and is visible to a fresh invocation; permission/401/429/5xx/unknown shapes don't cause password loops. Record natural expiry if observed; deliberate invalidation doesn't prove time-based expiry |
| Concurrent renewal | Separate invocations sharing a connection serialize renewal, reload current state and produce one exchange; test stale CAS, cancellation and expired-lease fencing, not just a local mutex |
| Independent sessions | Establish two sessions for the test-only login and check whether each remains accepted after the other renews; if this cannot be tested, record the limitation |
| Intervention and reset | A confirmed rejected password or real required-code response pauses later invocations/restarts without another login. Only approved credential change/reset resumes it; never request/retrieve/submit a code or repeatedly guess passwords |
| Missing payload / failed verification | Failed persistence, missing host session data and repeated fresh-login verification failure cannot create repeated login/email storms; verify real disconnect/hold behavior |
| Budgets | Measure complete login/read/action/refresh and response overhead under the host limit; include lock wait, storage, delayed dependencies and both pre- and post-submission timeouts |
| Uncertain write | After one controlled submitted request loses its response, the step cannot refresh, autoretry or replay it; prove actual task settings, operator visibility and failure notifications, including soft-stop behavior |
| Repeated add | Only after confirmed completion, inspect existing-member matching, counts, duplicates and notification effects, then authorize one repeat. A single observation never establishes idempotency or enables automatic replay |

The direct adapter passes only when a **supported host mechanism and deployed
evidence** meet every required durability, intervention, reset, coordination,
deadline and no-replay contract. Session/intervention state must be durable
together; all connection operations, cookie writes and resets need identity-wide
coordination, never-reused atomic revisions and fencing. No process-local queue,
mutated `authData`, successful auth-hook return alone or modeled store substitutes
for those guarantees. The current fixed generation has no production reset path.

An unverified or failed required gate blocks operational writes and cutover.
Record the exact failed requirement and evidence, distinguish unsupported from
unproven behavior, then resolve the hosted fallback design with the operator.
Don't weaken the contract or implement a Worker as part of verification.
[Session Auth](https://docs.zapier.com/integrations/build/sessionauth) documents the
auth exchange, while [operating constraints](https://docs.zapier.com/integrations/build/operating-constraints)
describe the stateless host and normal 30-second limits; neither establishes the
missing ordinary-action storage or distributed coordination mechanism.

## Cut over, roll back, then retire

Do these stages only after separate production authorization and all required
host/test-parish proof passes. Keep the legacy integration and current hosted
service running.

1. Privately inventory the existing Zap version, connection, triggers, filters,
   input mappings, response consumers, retries, autoreplay and notifications.
   Compare `group_id`, `user_first_name`, `user_last_name`, `user_email` and
   `user_mobile_phone`, stable string IDs/Everyone, strict real input formats and
   any subscriber-count consumer. The candidate omits unfetched counts and uses
   `is_everyone` instead of the old serializer key. Legacy opaque-ID write paths
   and listing completeness need proof; don't silently drop compatible groups.
2. Preserve a disabled rollback copy/export and the still-working Rails
   connection privately. Confirm the rollback operator can restore the old
   version without recovering credentials from logs. Configure a separate private
   replacement connection; never put credentials in ordinary action inputs.
3. Verify actual failure notifications and uncertain-write replay prevention.
   Soft-stopped rejections must be visible to the operator. Don't enable normal
   membership until the reviewed implementation has passed the host gates.
4. Pause competing triggers so the same source event cannot reach both paths.
   Point one controlled real workflow run at the replacement and inspect the
   confirmed result, resulting membership, session reuse and notifications. This
   is a production write needing its own target/record authorization.
5. If the controlled run passes, reconcile source events received during the
   pause against confirmed completed, not-submitted and unknown outcomes. Hold
   unknown events for inspection; don't replay completed or unreconciled events.
   Enable only the replacement for normal traffic, keeping the legacy path
   disabled but available for rollback. Resume only reconciled pending events
   through the replacement, verify traffic and notifications, then begin the
   agreed observation period. If the source can't recover paused events safely,
   resolve that before enabling normal traffic.
6. On failure or uncertainty, pause the replacement first. Inspect whether a
   write happened before replaying any event. Restore the saved Rails Zap and
   connection, verify it with an explicitly authorized controlled run, and resume
   only reconciled events. Restoring code doesn't undo a membership change.
7. Retire the old hosted service and endpoints only after accepted real-workflow
   proof, durable reuse across invocation/deployment, notification/replay checks,
   usable rollback and an agreed observation period. Verify no remaining consumer
   needs them, preserve rollback configuration, and obtain explicit retirement approval.

Until those steps pass, the current service remains the rollback path. This kit
contains no deployment, Zap editing, cleanup or shutdown automation.
