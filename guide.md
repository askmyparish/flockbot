# Set up Flockbot

Connect Flocknote to your assistant. By [AskMyParish](https://askmyparish.com).

Copy this into Codex on your desktop or in your terminal:

> Read https://raw.githubusercontent.com/askmyparish/flockbot/main/guide.md and help me set up Flockbot on this computer.

Codex will prepare Flockbot. On desktop, choose **Install** on the plugin page it
opens. In the terminal, Codex registers the plugin through its CLI instead.
Then start a new chat and say **Set up Flockbot**. Sign in only on Flocknote’s
website when asked. If a step cannot finish, Codex will explain what remains.

Setup currently targets **Mac with Apple silicon**. Windows setup is not yet
verified. On desktop, use a Codex host with local plugin support, such as Codex
in the ChatGPT desktop app. Other command-running assistants and web-only chats
are not supported by this guide. Setup needs a published release: if none is available, your
assistant should stop and explain that it isn’t ready yet.

Unofficial and independent. Not affiliated with, endorsed by or supported by Flocknote.

<details>
<summary>Instructions for the assistant</summary>

## Find the matching release

1. Before downloads or writes, confirm this is Codex CLI or a desktop Codex host
   with local plugin support (such as Codex in the ChatGPT desktop app). A local
   command runner alone is not enough. If the host is unsupported, stop; if its
   capability is unclear, ask which app/version before proceeding.
   Check the computer’s OS and architecture without reading personal files.
   Proceed with automated setup only on macOS Apple silicon. Do not run the Mac
   payload on Windows, Linux or Intel Mac, or promise support there.
2. Read the published releases at
   `https://api.github.com/repos/askmyparish/flockbot/releases`. Use the newest
   published, non-draft `mcp-v<version>` release containing both
   `flockbot-setup-<version>-darwin-arm64.md` and
   `flockbot-setup-<version>-darwin-arm64.zip`. Tell the user if it is a prerelease.
   If no matching release is available, stop. Never substitute repository source,
   a CI preview, a different publisher or an arbitrary executable URL.
3. Fetch the versioned Markdown prompt from that exact release’s assets on
   `github.com/askmyparish/flockbot`. Follow its fixed version, URL and SHA-256.
   Do not modify those values or choose a different archive after a failure.
   The release prompt verifies the archive before extraction and execution.

## Prepare Flockbot

Follow normal host approvals for downloads, commands and per-user files. Never
bypass OS or organization policy. No global Node, npm or Git installation is
needed. The setup package includes its pinned runtime; it also prepares a local
browser for later sign-in.

- **Desktop assistant:** use the prompt’s `--route desktop`. This prepares the
  local runtime and plugin source without discovering or requiring a Codex CLI.
  After success, open the returned `pluginPageUrl` with the OS URL opener under
  normal approvals (on Mac, `/usr/bin/open` with that URL as one quoted argument),
  or present it as an **Install Flockbot** link. It points to the local plugin
  page using the encoded absolute catalog path; do not invent a marketplace name.
  The user chooses **Install** in the app. Requesting a page does not prove it
  opened or the plugin was installed. If unavailable or missing, have the user
  quit and reopen their assistant, retry the link, or open **Plugins**, choose
  their personal source (its name may differ), then **Flockbot → Install**.
  Restart after an update if Flockbot was already installed. Never quit the app
  or send a chat message automatically.
- **Codex terminal session:** change only the prompt’s final route argument to
  `--route tui`. This uses the supported `codex` CLI on PATH to register the same
  source. Do not use private executables inside an application bundle or edit
  client configuration files. If the CLI is unavailable or unsupported, explain
  the remaining step; preserve prepared files and the saved connection.

Both routes share one plugin identity and connection. After installing/updating,
start a new conversation or reload the MCP connection, then run the installed
Flockbot setup skill. Follow the bounded setup result and remaining work. Stop
on integrity failures, downgrade refusals or ownership/schema conflicts; don’t
keep retrying or delete unfamiliar settings. See [recovery details](https://github.com/askmyparish/flockbot/blob/main/docs/mcp/setup.md).

## Connect and update

Ask only for the parish subdomain if needed. Use the installed `flocknote_connect`
tool and let the user enter passwords and codes on Flocknote’s real website.
Never ask for or inspect credentials, cookies, browser profiles or authentication
traffic. The connect tool waits briefly for sign-in; if it returns `ready`, resume
the original request without asking the user to type “done.” Only if it returns
`pending` should you ask the user to finish sign-in and let you know, then check
`flocknote_status` once before continuing. Never replay a write with unknown outcome.
Saved readiness is a previous sign-in, not proof of a fresh live authentication check.

To update, follow this guide using a newer matching published prompt. Preserve
the shared browser connection, restart/reload the assistant, and check status.
Never run Forget as a repair step. Uninstalling a client plugin and explicitly
forgetting a connection are separate actions.

Only claim actions you observed. Preparing files, registering a plugin, loading
its tools and signing in are separate states. Real-host, clean-machine and
Windows behavior remain unverified until exercised; no guide grants live-service
or publication permission.

</details>
