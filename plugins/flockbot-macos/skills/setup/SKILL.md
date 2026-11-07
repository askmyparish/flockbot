---
name: flockbot-setup
description: Set up or reconnect the local Flockbot Flocknote connector. Use when the user wants to install, connect, reconnect, check, update or explicitly forget their local Flocknote connection.
---

Flockbot is an unofficial independent connector published by AskMyParish.
It is not affiliated with, endorsed by or supported by Flocknote. It uses this OS
user's dedicated local browser profile. The guide-based desktop and TUI setup paths share one personal source and this
same connection. For a guided reinstall/update use the exact published release's versioned setup prompt; do not
choose an arbitrary executable URL or reset the connection. A new Codex session or
MCP restart is required after installing/updating host plugin files.

For **Update Flockbot** or an explicit update request, before step 1 read
https://raw.githubusercontent.com/askmyparish/flockbot/main/guide.md and follow its
published-release selection and verified versioned prompt for this desktop or TUI
host. Do not run this installed plugin’s old pinned setup script as an update.
Use the highest semantic version among the first 100 matching published releases,
including prereleases (tell the user). If an update notice names a version, do not
select an older version; stop if that release is no longer available. Preserve the
connection, respect normal approvals and explain restart/reload/new-chat steps.
Never install automatically or run Forget to update.

A tool may include a cached update notice. Answer the parish request first, then
briefly mention the version and say “Update Flockbot” to proceed. Label prereleases.
Never hide an error or unknown write outcome, interrupt sign-in, or replay a write.
The public metadata check runs at most once per 24 hours during use. A first fast
response may precede the check; a later response can show the notice. It does not
notify while Codex is closed. Offline checks fail quietly.

1. Resolve this installed plugin's directory from this skill's location (two parent directories). Run its `setup.sh` with `/bin/bash`. It downloads a checksum-pinned prepared runtime and installs its pinned Chromium. No Node, npm, Git or separate application installer is required from the user. Respect execution policy, OS and host permission prompts; never bypass trust controls.
2. If the runtime was newly installed, ask the user to restart the MCP connection or start a new Codex conversation so its tools become available. Do not repeatedly reinstall to fix a connection that only needs restarting.
3. Call `status`. If sign-in is needed, obtain the parish subdomain and call `connect`. Let the user sign in on the real Flocknote website and finish any code challenge there. Never ask for, inspect, read or return passwords, codes, cookies, browser profile files or authentication traffic.
4. `connect` keeps its call active briefly while sign-in finishes. When it returns `ready`, continue the user’s original parish request immediately; do not stop at a login confirmation or ask them to type “done.” If it returns `pending` after its bounded wait, tell the user to finish sign-in and let you know, then check `status` once and resume when ready. Do not poll indefinitely or treat sign-in alone as completion of their original task. Never repeat a write whose outcome is unknown.
5. For parish work, call the requested tool directly and trust the saved session. Status reports saved readiness without a live authentication check; only an auth-like operation failure triggers a diagnostic check. For additions supply a known groupId or the user's groupName for a case-insensitive unique match in one call, listing groups only when the choice is unclear. Never repeat a write whose outcome is unknown.

After updating the runtime, `setup.sh --stop` drains and stops the old local browser owner without forgetting the connection. Restart older MCP clients to load updated schemas; the next tool starts the installed owner. Otherwise an idle owner exits after five minutes.

If the user explicitly requests forgetting or replacing the saved connection, run this plugin's `setup.sh --forget`. This removes its local browser connection; it does not revoke the session at Flocknote or forensically erase backups. Then reconnect if requested. Never forget a connection merely to troubleshoot.

The plugin requires local Codex execution. Hosted web-only chats cannot run this local server. macOS Apple silicon and Windows x64 have separate plugins. The release and clean-desktop workflow must be verified before describing this candidate as supported. Windows behavior remains unverified.
