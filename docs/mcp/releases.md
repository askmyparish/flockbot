# MCP releases

Changesets prepares a reviewed release PR. Merging that PR into `main`
automatically builds and publishes the runtime/setup packages and their version tag.
Merging ordinary feature PRs does not publish a release. No npm registry publication is
configured.

## Feature development and previews

Add a changeset with `npm run changeset` for each user-visible MCP change. Select
`@askmyparish/flockbot-mcp` and write a concise explanation for the changelog.
Include shared-model and dependency changes that affect the connector. The client
and Zapier versions are independent of this release stream. Documentation and
test-only changes can omit a changeset.

PR CI runs the full offline check, platform MCP tests and setup checks on macOS
Apple silicon and Windows x64, and builds both platform archives. The workflow's
`codex-preview-<commit>` artifact contains runtime/setup ZIPs, the versioned setup
prompt, `artifacts.json` and `SHA256SUMS`, retained for seven days. These are review artifacts; the release PR must have matching integrity pins.
No Flocknote login or live service access is needed by any CI job.

## Preparing a version

After changes reach `main`, **Prepare MCP release** opens or updates a release PR.
It runs `npm run release:version`, which applies the pending Changesets, writes
`adapters/mcp/CHANGELOG.md`, synchronizes plugin and server versions, refreshes the
lockfile, builds both archives, and commits their checksum pins into that PR.

`adapters/mcp/package.json` owns the version. `npm run release:sync` generates the
server constant, both plugin manifest versions and their `runtime.version` files.
`npm run release:check` rejects drift and runs as part of `npm run check`.

Review the changelog, semantic version, dependency changes, setup checks and
checksum changes before merging. The release PR must receive normal review and
CI checks, including rebuilding both archives against the committed checksum
pins. The release bot uses a private GitHub App installed only for this
repository. Its short-lived token can write contents and pull requests; the
workflow revokes it when the preparation job ends. The built-in workflow token
remains read-only in that job. No personal access token or Flocknote secret is
needed.

Beta prereleases are enabled in `.changeset/pre.json`. The first release prepared
from the current local development candidate is `0.3.0-beta.0`. Subsequent feature
changesets advance the beta stream. Once installation and host verification are
complete, run `npm run changeset -- pre exit` in a reviewed PR to prepare a stable
version. Never reuse a beta version for stable assets.

Local preview builds also need distinct versions when plugin content changes.
For example, `0.2.1-dev.0` can update an earlier `0.2.0` preview without replacing
its immutable source. Preparing that local preview does not publish a release;
the reviewed release PR still owns the published version and checksum pins.

## Publishing the reviewed version

Merge the reviewed `changeset-release/main` PR into `main`. **Publish MCP
release** runs only for a merged release PR from the same repository, and checks
out its exact merge commit. Closed-but-unmerged PRs, fork PRs and ordinary feature
PRs cannot trigger publication. A separate tag push is unnecessary.

The workflow requires synchronized package/plugin versions and a nonempty
changelog section for that version. It reruns the complete checks, platform
setup checks and intercepted Chromium fixtures. `npm run package:codex -- --verify-pins`
rebuilds both archives and rejects any difference from the committed checksum
pins. Publication never repairs pins to accommodate an unexpected build.

After those checks pass, the publication job creates `mcp-v<version>` at the
reviewed merge commit. If the tag already exists, it must point to that exact
commit; the workflow never moves a tag. This also supports retrying a failed
publication. Every job verifies the same commit even if newer work reaches main.

Builds use the lockfile, pinned Node runtimes, normalized ZIP permissions and fixed
ZIP calendar timestamps. The timestamps are independent of the runner timezone.
`.node-version` selects Node for both CI and the bundled runtimes. When upgrading
it, also update the two official runtime archive checksums in the packager.
Checksums are also verified after transferring artifacts to the publication job.
GitHub signs build provenance for the exact archive bytes and reviewed merge
commit using a short-lived workflow identity. Only the publication job can write releases; PR checks cannot.

The workflow uploads runtime/setup ZIPs, the versioned setup prompt, the checksum file and artifact manifest to a draft
release, then publishes it with the reviewed changelog. Versions with a prerelease
suffix are marked as prereleases and do not replace the latest stable release.
Stable releases become latest. The setup scripts download only the version named
by the installed plugin and verify its pinned digest before activation.

Use the source catalog and plugins from the matching published tag when setting
up staff. `main` can contain a newly prepared version whose assets have not yet
been published. A release tag provides the matching source, version and pins.
Updating the runtime retains the separate local browser connection. macOS setup
serializes download, preparation and activation with the system `lockf` utility;
its persistent lock file must never be removed while a setup is running. Failed
or interrupted owned stages and incomplete targets recover on rerun, as described
in [setup recovery](./setup.md#reconnect-replace-and-remove). Windows activation
parity remains unverified and is not established by macOS process tests.

To verify an archive independently:

```sh
shasum -a 256 -c SHA256SUMS
gh attestation verify flockbot-codex-0.3.0-beta.0-darwin-arm64.zip --repo askmyparish/flockbot
```

## Repository setup and recovery

Register a private GitHub App owned by the repository owner. Grant repository
**Contents: read and write** and **Pull requests: read and write**; GitHub adds
Metadata read access automatically. No organization/account permissions, webhook,
OAuth user authorization, or device flow are needed. Install it using **Only
select repositories**, selecting this repository alone.

Set these repository Actions settings before enabling release preparation:

- Variable `RELEASE_APP_CLIENT_ID`: the App's nonsecret client ID.
- Secret `RELEASE_APP_PRIVATE_KEY`: its generated PEM signing key, transferred
  through a private credential channel. Keep it outside source, logs and chat.

The token action explicitly restricts its installation token to this repository
and the two permissions above. The App must be approved through normal organization
policy; the organization setting for Actions-created PRs does not need changing.
Rotate the signing key by replacing the Actions secret with a newly generated key,
then revoking the old key in the App settings after verification.

Protect `main` with required review and
the CI checks, and restrict creation, movement and deletion of `mcp-v*` tags to
release maintainers and the publication workflow using a tag ruleset. Do not
grant the release App a bypass for main-branch review requirements. Enable immutable releases under the
repository's release settings. The workflow uploads assets before publishing so
immutability can lock the complete release.

An additional protected GitHub environment can require approval before the
publication job if desired. This is repository policy, not required for local
builds. No repository setting is changed by adding these files.

If a release fails, inspect the failing check. A checksum mismatch requires fixing
the reproducibility problem or preparing a new reviewed version; do not overwrite
the recorded checksum during publication. A failed upload can leave an unpublished
draft. Remove only that failed draft after review, then rerun the workflow for the
same merged release PR event. The existing tag must still match the merge commit.
Do not move the tag or overwrite an already published release. Re-run a
successful build without publishing locally with `npm run package:codex -- --verify-pins`.

GitHub-hosted workflow execution and Windows behavior must still be observed after
these changes are pushed. Local tests do not establish that repository policies,
GitHub tokens or hosted Windows runners are configured successfully.

## Shared setup release artifacts

`npm run package:codex` also builds `flockbot-setup-<version>-darwin-arm64.zip`
and `flockbot-setup-<version>-darwin-arm64.md`. The ZIP contains the pinned Mac
runtime ZIP, matching source plugin/assets and `install.sh`. [guide.md](../../guide.md)
is the primary entry. Both routes invoke this script (`--route tui` or
`--route desktop`). Desktop
preparation skips CLI discovery/registration and writes no host install receipt;
the desktop app owns installation and reload. No signing/notarization occurs.

Build order prevents digest cycles: build/hash runtime, set/verify its plugin pin,
package/hash setup ZIP, then generate the external prompt containing the setup
ZIP's fixed published-release URL and SHA-256. The prompt is never embedded in the
archive it hashes. `artifacts.json` and `SHA256SUMS` include runtime, setup and
prompt identities. Both preview and release workflows transfer the prompt; release
checksums verify it too. `--verify-pins` rebuilds into an independent output path
when requested and rejects runtime pin drift without rewriting reviewed pins.

For an isolated reproducibility check, first run normal packaging to refresh pins
after runtime edits, then run `npm run package:codex -- --verify-pins --out
/path/to/separate-output`. Use the same cached official Node archives if working
offline. Only paste a prompt from the exact published release for staff; candidate
links remain unavailable before publication. Never replace immutable release bytes
or fix a failed download by asking a model to choose another URL.

No real desktop installation, clean-machine experience, representative-user
onboarding, Windows support or live Flocknote sign-in is established by
offline packaging fixtures. Those remain separate release gates.

## Audit the guide-based artifacts

```sh
npm run package:codex
npm run check:setup-package
npm run package:codex -- --verify-pins --out /path/to/separate-output
node scripts/mcp/check-setup-package.mjs /path/to/separate-output
```

The audit checks the four expected runtime/setup/prompt artifacts, every final
checksum, nested runtime pins and plugin identity, safe archive paths and private
data exclusions. No graphical app, Swift toolchain, installer ZIP, HTML setup
page or signing/notarization pipeline is part of this delivery. Platform runtime
ZIPs and setup scripts remain necessary because Flockbot executes locally.

Keep `guide.md` and its linked release instructions usable at the repository’s
published default branch before sharing the copyable prompt. Publish the exact
matching release assets through the reviewed release process. No local build
publishes either the guide or its download URLs.

Keep both plugin SVG copies identical to `assets/flockbot.svg`. After editing it,
a designer can regenerate the optional committed raster export with:

```sh
rsvg-convert -w 1024 -h 1024 -o assets/flockbot.png assets/flockbot.svg
```

librsvg is an artwork tool, not a setup or build prerequisite. The plugin uses the
square SVG; builds do not compile a native app icon.

| Surface | Current evidence | Still required |
| --- | --- | --- |
| Mac Apple silicon desktop | Offline preparation, no-CLI and connection-preservation fixtures | Real desktop install/reload, clean Mac and beginner completion |
| Codex terminal | Fixed-prompt and supported-CLI fixtures | Published prompt and real CLI update/reload acceptance |
| macOS system tools | Local lock/bootstrap process checks | Minimum OS and hosted Mac CI |
| Windows x64 | Experimental runtime/plugin package | Windows execution, recovery and user setup; guide does not run Mac payloads there |

Unlisted/shareable delivery remains provisional, without a public-directory
requirement or access-restriction promise. Browser sign-in/read-only verification
needs its separately authorized test-parish procedure. If a release fails,
preserve immutable bytes and the connection, withhold the affected prompt and
prepare a newer corrected release. Never reset sign-in or downgrade as repair.
Offline fixture results do not establish supported-host or end-user acceptance.
