#!/bin/bash
set -euo pipefail

flockbot_plugin="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
flockbot_version="$(cat "$flockbot_plugin/runtime.version")"
[[ "$flockbot_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || { echo 'Invalid Flockbot release version.' >&2; exit 1; }
flockbot_target=darwin-arm64
flockbot_digest="$(cat "$flockbot_plugin/runtime.sha256")"
[[ "$flockbot_digest" =~ ^[a-f0-9]{64}$ ]] || { echo 'Invalid Flockbot release digest.' >&2; exit 1; }
[[ "$(uname -s)" == Darwin && "$(uname -m)" == arm64 ]] || { echo 'This candidate requires an Apple silicon Mac.' >&2; exit 1; }
flockbot_base="${FLOCKBOT_INSTALL_ROOT:-$HOME/Library/Application Support/Flockbot MCP}"
flockbot_runtime="$flockbot_base/runtimes/$flockbot_version-$flockbot_target-${flockbot_digest:0:12}"
export PLAYWRIGHT_BROWSERS_PATH="$flockbot_base/browser-engines"

if [[ "${1:-}" == --launch || "${1:-}" == --forget || "${1:-}" == --stop ]]; then
  [[ -f "$flockbot_runtime/.complete" ]] || { echo 'Flockbot setup is required. Run the plugin setup skill.' >&2; exit 1; }
  if [[ "$1" == --forget ]]; then
    exec "$flockbot_runtime/node" --disable-warning=ExperimentalWarning "$flockbot_runtime/server/index.mjs" forget
  fi
  if [[ "$1" == --stop ]]; then
    exec "$flockbot_runtime/node" --disable-warning=ExperimentalWarning "$flockbot_runtime/server/index.mjs" stop
  fi
  exec "$flockbot_runtime/node" --disable-warning=ExperimentalWarning "$flockbot_runtime/server/index.mjs"
fi

umask 077
mkdir -p "$flockbot_base/runtimes"
[[ ! -L "$flockbot_base" && ! -L "$flockbot_runtime" ]] || { echo 'Flockbot install directory must not be a symlink.' >&2; exit 1; }
chmod 700 "$flockbot_base" "$flockbot_base/runtimes"
if [[ ! -f "$flockbot_runtime/.complete" ]]; then
  flockbot_stage="$(mktemp -d "$flockbot_base/runtimes/stage.XXXXXX")"
  trap 'rm -rf -- "$flockbot_stage"' EXIT
  flockbot_archive="$flockbot_stage/runtime.zip"
  if [[ -n "${1:-}" ]]; then
    cp -- "$1" "$flockbot_archive"
  else
    curl --fail --location --proto '=https' --proto-redir '=https' \
      "https://github.com/askmyparish/flockbot/releases/download/mcp-v$flockbot_version/flockbot-codex-$flockbot_version-$flockbot_target.zip" \
      --output "$flockbot_archive"
  fi
  flockbot_actual="$(shasum -a 256 "$flockbot_archive" | cut -d ' ' -f 1)"
  [[ "$flockbot_actual" == "$flockbot_digest" ]] || { echo 'Flockbot download failed its integrity check.' >&2; exit 1; }
  mkdir "$flockbot_stage/payload"
  unzip -q "$flockbot_archive" -d "$flockbot_stage/payload"
  "$flockbot_stage/payload/node" "$flockbot_stage/payload/setup-browser.mjs"
  touch "$flockbot_stage/payload/.complete"
  if [[ ! -e "$flockbot_runtime" ]]; then mv "$flockbot_stage/payload" "$flockbot_runtime"; fi
fi
[[ -f "$flockbot_runtime/.complete" ]] || { echo 'Flockbot runtime is incomplete. Remove the incomplete runtime directory and rerun setup.' >&2; exit 1; }
echo 'Flockbot runtime is ready. Restart the MCP connection or start a new Codex conversation, then use flocknote_connect.'
