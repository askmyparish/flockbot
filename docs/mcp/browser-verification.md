# Codex browser candidate verification

## Offline automated evidence

Run the commands below against the current checkout. Test counts and generated
archive digests change as the implementation evolves; they are not release
acceptance criteria. Windows execution and a clean staff installation require
separate verification.

- `npm run check`: core, Zapier and MCP types/tests/build/package imports. The
  browser package check tests real stdio tool discovery and an isolated bootstrap
  with a fictional local archive, including integrity rejection and paths with spaces.
- `npm run test:mcp:browser`: real Chromium with every page/API response intercepted
  and DNS disabled. Verifies a fictional session-only cookie through restarts,
  modern group discovery, counts, one membership submission, expiry/reconnection,
  redirect/body-size rejection and a disconnected write's unknown outcome.
  The warm-browser case verifies one Chromium launch through sign-in, discovery,
  a named addition and a count, with exactly one membership POST and no preflight
  for the cached named addition. Its write is fictional and fully intercepted.
  Expiry fixtures cover HTTP 401/403, denied JSON and HTML responses; diagnostics
  occur only after a failed operation, and an auth-rejected write is never replayed.
- Private-IPC tests launch separate client processes and one fixture browser owner.
  They verify shared reuse, cache reuse, owner-only socket/descriptor permissions,
  authenticated requests, nonce replay rejection, unsupported-operation rejection,
  cancellation/draining, idle restart and crash recovery without write replay.
  Clients with different temporary-directory environments share the same owner.
- `node scripts/mcp/verify-codex-browser.mjs`: opt-in macOS Apple silicon host check
  with the installed Codex CLI, a disposable configuration and a locally packaged
  runtime. Requires cached Chromium binaries. Codex CLI 0.166.0 on macOS Apple
  silicon installed the repository catalog/plugin and discovered all five tools
  without an MCP startup error. This verifies native plugin parsing and tool
  discovery through app-server, not desktop installation or live sign-in.

The real-browser fixture check intentionally uses mock credential storage and a
relaxed sandbox for disposable fictional profiles. It is not evidence of
production OS credential protection. Production removes those test defaults and
enables the Chromium sandbox.

## Live verification boundary

Authorized macOS test-parish checks have demonstrated browser sign-in, retained
sessions across MCP/runtime restarts, group discovery, current counts and
explicitly requested member additions. A read-only check confirmed saved status
does not launch Chromium. Live writes were not replayed to measure performance.

These observations do not establish notification/duplicate behavior, real expiry
signals beyond the documented userData shape, locked/denied credential-store
behavior, Windows support or a clean staff installation. Offline fixtures
establish the request-count, cancellation and uncertain-write contracts. Never
copy browser profiles, sign-in traffic or member contact records into verification
evidence.

## Required clean Codex desktop checks

- Add the source, install the correct plugin and run onboarding with no developer
  tools or preinstalled Node. Record exact OS/Codex versions and observed prompts.
- Verify the bootstrap restarts cleanly after a failed download, checksum mismatch,
  denied permission or interrupted browser installation.
- Verify production Chromium's sandbox and real OS credential store, including
  locked/denied/prompt behavior, with a disposable fictional session first.
- Verify sign-in opens visibly on the same computer, status returns pending, and
  another MCP process cannot open the same profile concurrently.
- Verify restart, expired session, changed-login refusal, explicit Forget and an
  update that retains the profile. Never copy profile data into evidence.
- Repeat on Windows x64. Mac automation and Windows package shape do not prove
  Windows execution, execution-policy acceptance or desktop trust.

## Explicitly authorized live test-parish checks

Routine tests never contact Flocknote. Before a live check, obtain explicit
operator authorization and the designated test parish. Staff enter credentials
privately on Flocknote's own website; do not inspect browser cookies, storage or
sign-in traffic.

1. Sign in and verify the selected parish and login without returning contact data.
2. Read groups and compare one subscriber count with Flocknote.
3. Restart the MCP connection and reuse the session without another sign-in.
4. For an explicitly authorized fictional test member and group, submit one addition
   and check its result and notification effects. Never repeat an unknown outcome.
5. Confirm actual CSRF requirements and session-expiry signals. Do not guess new
   authentication rules from a generic error or automatically retry a write.
6. Forget the local connection and verify tools require sign-in again.

GitHub release publication and a real clean-desktop setup are separate checks.
Passing offline tests does not establish either one.