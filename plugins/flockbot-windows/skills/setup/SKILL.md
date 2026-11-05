---
name: flockbot-setup
description: Set up or reconnect the local Flockbot Flocknote connector. Use when the user wants to install, connect, reconnect, check or explicitly forget their local Flocknote connection.
---

Flockbot is an independent connector published by AskMyParish, not affiliated with, endorsed by or supported by Flocknote. Flockbot is unofficial and uses this OS user's dedicated local browser profile.

1. Resolve this installed plugin's directory from this skill's location (two parent directories). Run its `setup.ps1` with Windows PowerShell using `-NoProfile -NonInteractive -File`. It downloads a checksum-pinned prepared runtime and installs its pinned Chromium. No Node, npm, Git or separate application installer is required from the user. Respect execution policy, OS and host permission prompts; never bypass trust controls.
2. If the runtime was newly installed, ask the user to restart the MCP connection or start a new Codex conversation so its tools become available. Do not repeatedly reinstall to fix a connection that only needs restarting.
3. Call `flocknote_status`. If sign-in is needed, obtain the parish subdomain and call `flocknote_connect`. Let the user sign in on the real Flocknote website and finish any code challenge there. Never ask for, inspect, read or return passwords, codes, cookies, browser profile files or authentication traffic.
4. `flocknote_connect` keeps its call active briefly while sign-in finishes. When it returns `ready`, continue the user’s original parish request immediately; do not stop at a login confirmation or ask them to type “done.” If it returns `pending` after its bounded wait, tell the user to finish sign-in and let you know, then check `flocknote_status` once and resume when ready. Do not poll indefinitely or treat sign-in alone as completion of their original task. Never repeat a write whose outcome is unknown.
5. For parish work, call the requested tool directly and trust the saved session. Status reports saved readiness without a live authentication check; only an auth-like operation failure triggers a diagnostic check. For additions supply a known groupId or the user's groupName for a case-insensitive unique match in one call, listing groups only when the choice is unclear. Never repeat a write whose outcome is unknown.

After updating the runtime, `setup.ps1 -Stop` drains and stops the old local browser owner without forgetting the connection. Restart older MCP clients to load updated schemas; the next tool starts the installed owner. Otherwise an idle owner exits after five minutes.

If the user explicitly requests forgetting or replacing the saved connection, run this plugin's `setup.ps1 -Forget`. This removes its local browser connection; it does not revoke the session at Flocknote or forensically erase backups. Then reconnect if requested. Never forget a connection merely to troubleshoot.

The plugin requires local Codex execution. Hosted web-only chats cannot run this local server. macOS Apple silicon and Windows x64 have separate plugins. The release and clean-desktop workflow must be verified before describing this candidate as supported. Windows behavior remains unverified.
