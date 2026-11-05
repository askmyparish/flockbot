import { createHash } from "node:crypto";
import { copyFile, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { zipDirectory } from "./archive.mjs";
import { compareVersions } from "./installer/install-core.mjs";

export function setupPrompt({ version, filename, sha256 }) {
  compareVersions(version, version);
  if (
    !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(version) ||
    filename !== `flockbot-setup-${version}-darwin-arm64.zip` ||
    !/^[a-f0-9]{64}$/.test(sha256)
  )
    throw new Error("Invalid setup release metadata.");
  const url = `https://github.com/askmyparish/flockbot/releases/download/mcp-v${version}/${filename}`;
  return `Set up Flockbot ${version}, an unofficial independent Flocknote connector by AskMyParish (https://askmyparish.com), on this computer. Not affiliated with, endorsed by or supported by Flocknote. macOS Apple silicon only; Windows is unverified. Use normal host file/command approvals. Stop if OS or organization policy blocks access. Never ask for passwords, codes, cookies or browser-profile contents in chat.

Before downloads or writes, confirm this is Codex CLI or a desktop Codex host with local plugin support, such as Codex in the ChatGPT desktop app. A desktop command runner alone is not enough. Stop for unsupported hosts; ask which app/version if capability is unclear.

Use the desktop route below in that desktop Codex host. It prepares files without a separate Codex CLI; the user finishes through the assistant's Plugins page. In an actual Codex CLI/TUI session, change only the final route argument to --route tui to register with the supported installed codex CLI on PATH. Never use a private app-bundled CLI or edit TOML. Both routes use the same source and connection. No graphical Flockbot installer is involved. No global Node, npm or Git is needed. A local browser is needed for sign-in later.

This exact release must be published before the commands can work. Check this computer is macOS Apple silicon before running them. Use /bin/bash, curl, shasum, unzip and the system lockf utility. Download into a fresh temporary directory and verify the fixed SHA-256 BEFORE extracting or executing. Do not substitute another executable URL, version or digest. Never pipe a download into a shell. Run this block with /bin/bash:

\`\`\`sh
set -euo pipefail
flockbot_setup_dir="$(mktemp -d)"
cd "$flockbot_setup_dir"
curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --connect-timeout 15 --max-time 180 '${url}' --output '${filename}'
printf '%s  %s\\n' '${sha256}' '${filename}' | shasum -a 256 -c -
unzip -q '${filename}' -d payload
/bin/bash payload/install.sh --route desktop
\`\`\`

Report the bounded result and requested/installed versions when present, using plain language. Do not mistake file preparation for host installation or sign-in. If host is manual_install_required, open its returned pluginPageUrl through the normal OS URL opener (on Mac, /usr/bin/open with the URL as one quoted argument) under normal host approvals, or show an Install Flockbot link. The URL targets the local plugin page; the user confirms Install. Do not expose the encoded home path as troubleshooting text or substitute a marketplace name. If the page is unavailable or Flockbot is missing, ask the user to quit and reopen their desktop assistant and retry the link, or use Plugins → their personal source (existing name may differ) → Flockbot → Install. Restart after an update if Flockbot was already installed. Never quit the app automatically. Start a new chat and ask “Set up Flockbot.” Never claim a plugin page opened or that a plugin was installed without evidence. In TUI, host reload_required means start a new session/reload the MCP connection and run the installed setup skill. For codex_missing/unsupported/failed, keep the prepared source and connection; resolve the CLI problem through official supported instructions before retrying the TUI route, or use the desktop route.

Do not blindly retry refusals. For downgrade_rejected use the installed or newer compatible release; version_collision needs matching verified release bytes. For ownership_conflict, malformed_data or source_changed preserve existing files and have their catalog/source or connection metadata reconciled before retrying. For connection_incompatible use a compatible release without resetting the connection. Other failures need their stated cause resolved. Never run Forget to repair setup.

After installation/reload, check flocknote_status through the installed plugin. Saved readiness describes a previous sign-in, not a fresh authentication check. If sign-in is required, ask only for the parish subdomain and call flocknote_connect. The user enters passwords and codes solely on Flocknote's real website. Check status when the user says sign-in is complete. No real-host or sign-in success is established by this prompt.
`;
}

export async function buildSetupRelease({
  stage,
  out,
  version,
  runtime,
  plugin = "plugins/flockbot-macos",
}) {
  compareVersions(version, version);
  const manifest = JSON.parse(
    await readFile(join(plugin, ".codex-plugin/plugin.json"), "utf8"),
  );
  const pinnedVersion = (
    await readFile(join(plugin, "runtime.version"), "utf8")
  ).trim();
  const pinnedDigest = (
    await readFile(join(plugin, "runtime.sha256"), "utf8")
  ).trim();
  if (
    manifest.version !== version ||
    pinnedVersion !== version ||
    createHash("sha256")
      .update(await readFile(runtime))
      .digest("hex") !== pinnedDigest
  )
    throw new Error("Setup package does not match the pinned release.");
  await mkdir(stage, { recursive: true });
  await cp(plugin, join(stage, "plugin"), { recursive: true });
  await copyFile(runtime, join(stage, "runtime.zip"));
  await copyFile("scripts/mcp/installer/install.sh", join(stage, "install.sh"));
  const filename = `flockbot-setup-${version}-darwin-arm64.zip`;
  await zipDirectory(stage, join(out, filename));
  const sha256 = createHash("sha256")
    .update(await readFile(join(out, filename)))
    .digest("hex");
  const prompt = `flockbot-setup-${version}-darwin-arm64.md`;
  await writeFile(
    join(out, prompt),
    setupPrompt({ version, filename, sha256 }),
  );
  return [
    { filename, sha256, target: "darwin-arm64", kind: "setup" },
    {
      filename: prompt,
      sha256: createHash("sha256")
        .update(await readFile(join(out, prompt)))
        .digest("hex"),
      target: "darwin-arm64",
      kind: "setup-prompt",
    },
  ];
}
