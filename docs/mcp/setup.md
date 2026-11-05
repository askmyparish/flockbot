# Local setup and updates

Start with [guide.md](../../guide.md): copy its short prompt into a local desktop
Codex host with local plugin support (such as Codex in the ChatGPT desktop app)
or Codex terminal session. Other desktop assistants are not supported; stop before
preparing files if the host lacks local Codex plugins. The assistant follows the matching published
release prompt and prepares Flockbot. No graphical Flockbot app is installed.

Flockbot is an unofficial, independent connector by
[AskMyParish](https://askmyparish.com). It is not affiliated with, endorsed by or
supported by Flocknote. Automated guided setup targets macOS Apple silicon.
Windows remains experimental and unverified. A web-only chat cannot execute this
local connector. Sign-in happens on Flocknote’s website in a local browser.

## Published setup prompt

Use `flockbot-setup-<version>-darwin-arm64.md` from the chosen `mcp-v<version>`
GitHub release. The guide explains how an assistant finds that exact published
asset. If no matching release is published, stop: a generated preview prompt does
not make its download URL live. Never substitute `main`, another executable URL
or an unverified archive after a failed download.

The versioned prompt downloads a fixed setup ZIP into a fresh temporary directory,
verifies its SHA-256, then extracts and runs it. It never pipes downloads into a
shell. Downloads and initial browser preparation need internet access. Respect
normal host/OS approvals and organization policy.

- **Desktop:** `install.sh --route desktop` prepares the runtime and personal
  plugin source without requiring or discovering a separate Codex CLI. The
  bounded result includes `pluginPageUrl`, a
  `codex://plugins/flockbot-macos?marketplacePath=<encoded-absolute-catalog-path>`
  link. The assistant may open that URL under normal approvals or show an
  **Install Flockbot** link; the user confirms **Install** in the app. If the page
  or plugin is unavailable, quit and reopen the assistant and retry, or use
  **Plugins → Personal plugins** (or the source’s existing name) → **Flockbot → Install**.
  Restart after an update if already installed. Start a new chat and ask **Set up Flockbot**.
- **Terminal:** the prompt’s permitted `--route tui` variant registers that same
  source through the supported `codex` CLI on PATH. Start a new session/reload
  the MCP connection, then run the installed Flockbot setup skill. Missing or
  unsupported CLI is actionable failure; prepared files/connection are kept.

Both routes use one source identity, immutable versioned runtime and separate
per-user browser connection. Desktop preparation reports host installation as
pending; the core does not open URLs, install a plugin or send a message.
The guide directs the assistant to request the local plugin page afterward.
First-time discovery may still need a restart; the link is not a silent install. This host
handoff still needs real desktop/clean-machine verification.

Setup uses Mac system `/bin/bash`, `curl`, `shasum`, `unzip` and `/usr/bin/lockf`
with descriptor support. Node is included in the pinned runtime, so users do not
install global Node, npm or Git. Do not locate private app-bundled CLIs or edit
TOML. Minimum macOS/system-tool compatibility remains unverified.

The setup ZIP contains `install.sh`, the matching plugin/assets and the pinned
runtime ZIP. Repeating a compatible prompt retains the saved connection. There
is no separate application, updater, Flockbot account or public marketplace
listing requirement.

## What the setup result means

The last stdout line is bounded JSON with `schema: 1`, `ok` and `remaining`.
Successful setup includes source `version`, `requestedVersion`, `installedVersion`,
marketplace/plugin identity, `sourceIdentity` and source/runtime/host/connection
state. Refusals include only state already established safely: the validated
requested version, trusted installed version when known, runtime preparation and
source/connection state. Omitted fields are unknown; `host: not_checked` does not
mean an existing host installation was removed. `source: retained` means the prior
verified catalog source remains usable; `connection: unrecognized` means metadata
could not establish a compatible saved state. No failure establishes readiness.
Errors use fixed codes; raw Codex output, local paths, parish/login identifiers,
cookies and broker keys are not returned. Runtime preparation diagnostics appear
on stderr. `ok: true` means source preparation and, for the CLI route, the requested host command
completed; `host: manual_install_required` on the desktop route means desktop
installation has not been attempted; **host reload and checking the saved connection remain explicit work**.

| State or error | Next step |
| --- | --- |
| `source: prepared` / `reused` | The immutable owned plugin source is present; reuse leaves its catalog bytes and mtime alone |
| `runtime: prepared` | This release's completed pinned runtime exists; this is not a browser/sign-in check |
| `runtime: preparation_required` | Run the release's `install.sh`; invoking the source core alone does not prepare a runtime |
| `host: manual_install_required` | Open Plugins → your personal source → Flockbot → Install, then restart; no CLI is needed for desktop |
| `host: reload_required` | Start a new Codex session/restart the MCP connection; desktop may need an application restart |
| `connection: saved_ready` | Sign-in previously completed; run `flocknote_status` after reload, not a fresh authentication probe |
| `sign_in_required` / `sign_in_pending` | Complete the installed setup skill and local browser sign-in as needed |
| `codex_missing` / `codex_unsupported` | Install/update the supported official CLI on PATH, then rerun the same release |
| `codex_failed` / `host_source_conflict` | Resolve host permissions/policy or an existing conflicting source using Codex's supported commands, then rerun |
| `malformed_data` / `duplicate_entry` / `ownership_conflict` | `repair_malformed_data` / `reconcile_ownership_conflict`: preserve the conflicting files; have an administrator reconcile the catalog/source or malformed host response before retrying |
| `concurrent_edit` / `source_changed` | `finish_other_writer_then_retry` / `restore_verified_source`: finish the other edit or restore the changed source from verified release bytes before retrying; preserve the lock |
| `downgrade_rejected` | `use_current_or_newer_release`: use the installed or newer compatible release; repeating the old prompt cannot work |
| `version_collision` / `connection_incompatible` | `obtain_matching_release` / `use_compatible_release`: obtain the matching verified or compatible release; do not downgrade or reset the browser profile |
| `runtime_preparation_failed` / `coordination_failed` / `installation_failed` | Resolve tool, permission, disk or interrupted-setup failure and rerun; readiness was not established |

The `remaining` action on a refusal names the repair required before another
attempt. A recoverable failure says retry only after resolving that cause. Never
interpret an old prompt's version refusal as permission to reinstall that release.

Once the host has reloaded, run the installed Flockbot setup skill. If sign-in is
needed, supply only the parish subdomain, then sign in on Flocknote's real website
and finish any code challenge there. Passwords, codes and cookies never belong in
chat, prompts, configuration or shell arguments. `flocknote_status` reports saved
readiness; ordinary tasks trust it until an authentication-like operation failure
requires diagnosis. Never repeat a write whose outcome is unknown.

## One owned personal source

The core merges `~/.agents/plugins/marketplace.json` and preserves its existing
name, unrelated plugins, unknown fields and file mode. A missing catalog uses
`flockbot-personal`; commands always use the resolved name, never assume that
default for an existing catalog. The one Mac plugin identity is `flockbot-macos`.
Its source lives under `~/.flockbot/sources/<version>-<content-identity>` with a
schema/version/compatibility ownership receipt and a matching catalog marker.
Only exact owned source content is reused. Foreign or ambiguous entries, duplicate
JSON keys/names, unsupported schemas, links and unexpected edits are refused.

Source stages carry a bounded ownership sidecar, published by atomic rename and
synced before the stage directory is created. The sidecar stays outside the stage
until recursive cleanup and directory removal are complete and synced. Thus a
crash before/during marker writing or after marker removal can be retried under
the same lock. A valid intent with no stage is safely retired. Complete legacy
markers are adopted into this protocol before cleanup; unmarked stages without a
valid sidecar and malformed/foreign intents are preserved and refused. Partial
intent temporary files outside the stages directory are preserved, never used as
authority to remove a directory. Administrator reconciliation must account for
these source-stage conflicts too; do not delete active lock/stage files.

A process OS lock coordinates all core calls through the persistent
`~/.flockbot-install.lock` inode. Child host commands inherit it, including if the
calling process dies. Never remove this lock file. Only marked abandoned source
stages are reclaimed. A complete source is activated before atomically replacing
the catalog; prior versions are retained, so a failed host install or interrupted
catalog update does not leave a pointer to deleted payload. Source and catalog
checks detect unexpected content edits before activation; other editors should
finish before setup and must not bypass the shared lock during its commit.

Host registration/install uses only documented local commands:
`codex plugin marketplace add <home> --json` and
`codex plugin add flockbot-macos@<resolved-name> --json`. Supported list commands
check for host source collisions first. An owned receipt under `~/.flockbot/hosts`
records successful installation per Codex configuration directory; matching host
list presence allows unchanged repeat/cross-route setup to skip installation. It
does not prove a client has reloaded or authenticated. Host configuration belongs to Codex; the
core never edits TOML, removes another marketplace or silently installs a second
Flockbot identity from another source. A pre-existing checkout/Git marketplace
installation must be reconciled explicitly in Codex if it conflicts. No Git
checkout is needed for the released personal-source route.

Reinstall with the same release or update using the newer release's fixed prompt.
Updates switch the catalog to a new owned immutable source and retain the old
source/runtime. Semantic version comparison includes prerelease ordering and
rejects downgrades and different bytes claiming the same version. The current
receipt contract is browser-v1, broker protocol 1 and Node 22; unsupported ownership
or connection-metadata schemas fail without migration. Setup preserves the exact
browser connection metadata and profile; it never opens the broker descriptor or
reads browser session files. The runtime override `FLOCKBOT_INSTALL_ROOT` is for
isolated checks and never changes the OS-user connection location.

Compatible clients reuse the current browser owner after an update; it exits after
five idle minutes. To activate owner changes immediately, use only the installed
plugin's existing `setup.sh --stop`, then restart older MCP clients. This drains
current work without forgetting the connection. The next tool starts the new
owner. Do not delete browser files or call Forget to repair an update.

Official behavior references: [plugin packaging and personal marketplaces](https://developers.openai.com/plugins/build/plugins),
[CLI registration/install commands and JSON results](https://learn.chatgpt.com/docs/developer-commands?surface=cli),
and [TUI plugin onboarding](https://developers.openai.com/learn/developers-codex-plugin).
These document supported commands, not evidence of this candidate working in a
real desktop or a clean staff environment.

## Reconnect, replace and remove

On macOS, rerun the same plugin setup skill after a failed or interrupted setup.
It serializes setup across processes with the system `lockf` utility, waits up to
two minutes for an active setup, and never steals its lock because it looks old.
A slow setup may still be running: let it finish before retrying. Do not delete
the lock file or temporary directories while setup is active.

A retry removes only marked stages left by a previous lock holder and repairs an
empty target or an incomplete runtime carrying this release's ownership receipt.
A legacy incomplete target without a receipt is repaired only when every remaining
file matches the checksum-verified archive; foreign additions are preserved.
It preserves completed runtimes, unrecognized files and the separate browser
profile. A foreign collision or damaged completion marker requires administrator
help or a separate install root; setup reports the conflict without replacing it.
Install paths, including their ancestors and the browser cache, must be direct
local directories without symlinks. No manual directory deletion is needed for
an owned interrupted setup.

Downloads have a 15-second connection limit and a three-minute total limit.
Browser preparation has a five-minute limit, with a 30-second socket idle timeout
for browser downloads. On macOS a temporary supervisor retains that deadline and
the lock if the calling shell and helper are killed. Ordinary interrupt, terminate
and hangup signals stop browser preparation before its stage is removed. A retry
waits until surviving download work has stopped before reclaiming the stage.
System `lockf` descriptor support still needs verification on the minimum macOS
version and CI runner; current local evidence does not establish that support.
If setup reports a timeout or integrity, permission or disk failure, resolve that
cause and rerun setup with the same published plugin.
Failures do not report readiness. A ready immutable runtime is reused without a
download, and launch, stop and forget commands never install software.

These activation/recovery checks apply to the macOS candidate. Windows activation
has not been hardened or executed in this change; Windows packaging remains
experimental and unverified. The shared browser-preparation deadline is present,
but Windows concurrency and interrupted-setup recovery still need implementation
and native verification before support can be claimed.

A confirmed expired session pauses tools until the user opens sign-in again. No
password renewal, email-code retrieval or automatic write retry occurs. A network
or permission failure is not treated as proof of expiry.

Replacing the selected parish or Flocknote login requires an explicit request to
forget the old connection. The setup skill can then run `setup.sh --forget` or
`setup.ps1 -Forget` and reconnect. These operator commands are deliberately absent
from ordinary MCP tools. Forgetting removes this connector's dedicated browser
profile and connection metadata; it does not revoke the session at Flocknote or
erase backups. Uninstalling a plugin alone leaves the separate local profile.

## Removing the client plugin and retained source

Use Codex's plugin UI or `codex plugin remove flockbot-macos@<resolved-name>` to
remove that client's installed cache/config entry. It leaves the personal source,
immutable runtimes and shared browser connection available to other contexts.
The retained `~/.flockbot` source is owned by the shared setup core; do not delete it while a personal catalog
entry or another context references it. This core intentionally does not garbage
collect retained source versions or remove the personal catalog. Any later source
cleanup must verify receipts and remove references before payloads. Forget is a
separate explicit connection operation, described above, never an uninstall or
repair prerequisite.

## Troubleshooting setup

- **Missing or unsupported desktop app:** install/update a host that supports local
  Codex plugins through its official distribution; rerun the same release prompt.
  Being able to run commands or having a URL handler alone does not establish
  local Codex plugin support. Confirm the host before preparing files.
- **Download, integrity or preparation failure:** check network, free disk space
  and normal file permissions. Obtain the same verified release again if damaged.
  No readiness was established. Never skip a checksum or OS trust decision.
- **Denied access or organization policy:** ask your administrator to permit normal
  local setup. Do not change security settings to make the candidate run.
- **Interrupted setup:** wait for active preparation to stop and rerun the same
  release prompt. Owned partial work is recovered by the shared core; keep lock files.
- **Files prepared, plugin missing/old:** restart the desktop app, select the personal
  source in Plugins and Install/update Flockbot. A link can fall back to Plugins;
  follow the plugin-page and Plugins fallback steps above. Installation, reload and sign-in remain pending
  until performed in the host. A source version is not a loaded-host version.
- **Conflicting or unfamiliar settings:** keep the files and connection and ask an
  administrator to reconcile them. Setup refuses ambiguous ownership and unknown
  connection schemas rather than replacing them.

Update using a newer matching published prompt from [guide.md](../../guide.md).
Switching routes reuses the same source and preserves a compatible browser session.
For an expired session, rerun the installed setup skill and sign in on Flocknote’s
website. Use the desktop plugin UI to uninstall; see the separate explicit Forget
procedure above only when intentionally replacing/removing the shared connection.

## Releases

The [release workflow](./releases.md) uses reviewed Changesets release PRs, then
automatically publishes GitHub assets and the matching `mcp-v<version>` tag when
the release PR is merged.
Use the plugins from that published tag, including their `runtime.version` and
`runtime.sha256` files. CI previews are available for review before publication.
Until a version is published, its default GitHub download URL is unavailable.

## Update notices

During tool use, the MCP process starts a bounded, asynchronous public GitHub
release-metadata check at most once per 24 hours per OS user. A separate
`updates-v1/checks.sqlite` cache under the Flockbot application-data directory
stores only the attempt time and public release version; it never reads the
browser profile or sends parish/session/contact data to GitHub. Failed checks
also consume the daily budget. `FLOCKBOT_UPDATE_CHECKS=0` disables discovery
entirely; the offline package and host-verification runners set it explicitly. An unavailable or unsafe cache disables checks
quietly; it does not affect parish work. Checks are currently for the automated
macOS Apple silicon setup route; Windows remains unverified.

Tool responses can include `update` with installed/available versions, prerelease
status, the fixed guide URL and a fixed message. The assistant answers the parish
request first, then offers **Update Flockbot**. It must preserve errors and unknown
write outcomes. The 5-second request/body deadline, 1 MiB body cap and rejected
redirects bound metadata work; tool handlers never await that network work. A fast
first response may precede discovery; a later response sees the cached result.
No notification is sent while Codex is closed, and nothing installs automatically.

Discovery chooses the highest semantic version among the first 20 published,
non-draft `mcp-v` releases with exact matching uploaded setup ZIP/prompt assets
from this repository. The guide scans the first 100 releases, a superset of that
lookup, and never selects below the notice or installed version. Prereleases are included and labeled. Drafts, invalid
versions, mismatched asset URLs and releases lacking either asset are ignored.
An explicit update uses the current guide and fixed-digest release prompt, not the
installed skill’s older pinned runtime. Preserve sign-in and restart/reload as
instructed above. Actual host/model rendering of notices and published downloads
need real-user verification; fixture tests do not establish them.

The public-version cache is retained after Forget or plugin removal. It contains
no sign-in state; those actions do not trigger another update lookup. Automated
update notices and the guide’s installation/update route are Mac-only for now;
the Windows skill stops explicit update requests without changing the connection.
