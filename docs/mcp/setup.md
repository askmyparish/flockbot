# Codex setup and GitHub distribution

This candidate targets local Codex on macOS Apple silicon first. A separate
Windows x64 plugin is packaged but has not been executed on Windows. It is
unofficial and uses each OS user's own Flocknote login and dedicated browser
profile.

## Staff workflow after a release is available

1. Add the Flockbot GitHub plugin source using the published setup prompt, or have
   the workspace administrator configure it. The repository catalog contains a Mac
   plugin and a Windows plugin. No public directory listing is needed.
2. Install the plugin for this computer and run its setup skill in local Codex.
3. Approve required host/OS permissions. The setup script downloads a prepared
   Node/connector bundle, verifies its pinned SHA-256 digest, and installs that
   bundle's pinned Chromium. Staff don't install Node, npm or Git separately.
4. Restart the MCP connection or start a new Codex conversation when instructed.
5. Ask to connect Flocknote and supply the parish subdomain. Sign in on Flocknote's
   real website and finish any authentication code there. No login detail belongs
   in chat, plugin configuration or setup-script arguments.
6. Ask Codex to check the connection, then list groups or perform a requested task.

GitHub distribution does not enable hosted web-only execution. The local connector
and browser must run on the staff member's computer. Do not bypass macOS trust
warnings, Windows execution policy or organization restrictions.

The intended setup prompt is:

> Set up Flockbot from askmyparish/flockbot using its published Codex setup instructions. Install the plugin for this computer, run its setup, and help me sign in to Flocknote. Keep passwords and authentication codes out of this conversation.

This is a target workflow requiring clean-desktop verification, not a promise that
any chat can install an arbitrary GitHub URL. A local setup task needs authorized
file/command access, and the source must be registered before its plugin can be
selected.

## Current local checkout checks

The source catalog is `.agents/plugins/marketplace.json`. The plugins use the
supported `.codex-plugin/plugin.json` and `.mcp.json` compatibility format, which
was verified with Codex CLI 0.166.0. Relative launch paths resolve from the
installed plugin root. The newer portable manifest format was not loaded by that
host. Once these files are published to a chosen Git ref, Codex can register that
GitHub source. While the changes are local, use a checkout path instead:

```sh
codex plugin marketplace add /path/to/flockbot
codex plugin add flockbot-macos@flockbot
# Or on Windows: codex plugin add flockbot-windows@flockbot
```

Native commands are operator checks, not proof of the staff UI. Codex's current
CLI calls installation `plugin add`; other client versions may expose a different
UI. Use the installed plugin's onboarding skill rather than editing MCP config.

Before a GitHub release exists, a developer can provide a locally built bundle to
the same setup script:

```sh
bash plugins/flockbot-macos/setup.sh /path/to/flockbot-codex-0.2.0-darwin-arm64.zip
```

On Windows, the equivalent is `setup.ps1 -Bundle <archive>`. The archive must
match the integrity pin in that plugin. `FLOCKBOT_INSTALL_ROOT` may point to a
disposable runtime directory during isolated packaging checks; it never changes
the browser connection's OS-user profile location.

Normal tool startup never downloads software: it uses a completed immutable
runtime or reports that setup is needed. Incomplete downloads are not activated. A
prepared runtime is addressed by version, platform and checksum, so updates do not
overwrite a running installation. Browser binaries have a separate cache. The
browser profile is outside both caches and survives plugin removal/updates.
Compatible MCP clients reuse an existing local browser owner, including across a
runtime update. Updated owner code takes effect after its five-minute idle exit.
For immediate activation, run `setup.sh --stop` or `setup.ps1 -Stop` once setup
completes. This drains current work and closes the browser without forgetting the
connection; the next tool call starts the installed runtime. Restart older MCP
clients as well so they use the updated tool schemas and instructions.

## Reconnect, replace and remove

If setup reports an incomplete runtime, remove only that incomplete version's
directory beneath `runtimes` and rerun setup. The browser profile lives outside
`runtimes`; keep it when repairing an installation. Setup never reports readiness
for a runtime missing its completion marker.

A confirmed expired session pauses tools until the user opens sign-in again. No
password renewal, email-code retrieval or automatic write retry occurs. A network
or permission failure is not treated as proof of expiry.

Replacing the selected parish or Flocknote login requires an explicit request to
forget the old connection. The setup skill can then run `setup.sh --forget` or
`setup.ps1 -Forget` and reconnect. These operator commands are deliberately absent
from ordinary MCP tools. Forgetting removes this connector's dedicated browser
profile and connection metadata; it does not revoke the session at Flocknote or
erase backups. Uninstalling a plugin alone leaves the separate local profile.

## Releases

The [release workflow](./releases.md) uses reviewed Changesets release PRs, then
automatically publishes GitHub assets and the matching `mcp-v<version>` tag when
the release PR is merged.
Use the plugins from that published tag, including their `runtime.version` and
`runtime.sha256` files. CI previews are available for review before publication.
Until a version is published, its default GitHub download URL is unavailable.
