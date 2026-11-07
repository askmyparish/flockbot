#!/bin/bash
set -euo pipefail

fail() { echo "$1" >&2; exit 1; }
flockbot_plugin="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
flockbot_version="$(cat "$flockbot_plugin/runtime.version")"
[[ "$flockbot_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || fail 'Invalid Flockbot release version.'
flockbot_target=darwin-arm64
flockbot_digest="$(cat "$flockbot_plugin/runtime.sha256")"
[[ "$flockbot_digest" =~ ^[a-f0-9]{64}$ ]] || fail 'Invalid Flockbot release digest.'
[[ "$(uname -s)" == Darwin && "$(uname -m)" == arm64 ]] || fail 'This candidate requires an Apple silicon Mac.'
flockbot_base="${FLOCKBOT_INSTALL_ROOT:-$HOME/Library/Application Support/Flockbot MCP}"
[[ "$flockbot_base" == /* ]] || flockbot_base="$PWD/$flockbot_base"
flockbot_runtime="$flockbot_base/runtimes/$flockbot_version-$flockbot_target-${flockbot_digest:0:12}"
flockbot_identity="flockbot-runtime-v1:$flockbot_version:$flockbot_target:$flockbot_digest"
export PLAYWRIGHT_BROWSERS_PATH="$flockbot_base/browser-engines"

# Check every ancestor before creating or following anything beneath it. Local
# installation directories must not redirect into a profile or another tree.
check_path() {
  local rest="${1#/}" part path=''
  while [[ -n "$rest" ]]; do
    part="${rest%%/*}"
    if [[ "$rest" == */* ]]; then rest="${rest#*/}"; else rest=''; fi
    [[ -n "$part" && "$part" != . && "$part" != .. ]] || fail 'Use an absolute, direct Flockbot install directory without dot components.'
    path="$path/$part"
    [[ ! -L "$path" ]] || fail 'Flockbot install paths must not contain symlinks.'
    [[ ! -e "$path" || -d "$path" ]] || fail 'A file conflicts with the Flockbot install directory. Choose a separate install root.'
  done
}
check_path "$flockbot_runtime"
check_path "$PLAYWRIGHT_BROWSERS_PATH"

valid_payload() {
  local root="$1"
  [[ -d "$root" && ! -L "$root" && -x "$root/node" && -s "$root/server/index.mjs" && -s "$root/setup-browser.mjs" && -s "$root/node_modules/playwright/cli.js" && -f "$root/package.json" ]] || return 1
  [[ -z "$(find "$root" ! -type d ! -type f -print -quit)" ]] || return 1
  [[ "$(cat "$root/package.json")" == "{\"name\":\"flockbot-local-runtime\",\"version\":\"$flockbot_version\",\"private\":true,\"type\":\"module\"}" ]]
}
ready() {
  [[ -f "$flockbot_runtime/.complete" && ! -L "$flockbot_runtime/.complete" ]] || return 1
  # Empty markers belong to the original immutable bootstrap and remain usable.
  [[ ! -s "$flockbot_runtime/.complete" || "$(cat "$flockbot_runtime/.complete")" == "$flockbot_identity" ]] || return 1
  valid_payload "$flockbot_runtime"
}
if [[ "${1:-}" == --launch || "${1:-}" == --forget || "${1:-}" == --stop ]]; then
  ready || fail 'Flockbot setup is required. Rerun the plugin setup skill.'
  if [[ "$1" == --forget ]]; then
    exec "$flockbot_runtime/node" --disable-warning=ExperimentalWarning "$flockbot_runtime/server/index.mjs" forget
  elif [[ "$1" == --stop ]]; then
    exec "$flockbot_runtime/node" --disable-warning=ExperimentalWarning "$flockbot_runtime/server/index.mjs" stop
  fi
  exec "$flockbot_runtime/node" --disable-warning=ExperimentalWarning "$flockbot_runtime/server/index.mjs"
fi
[[ $# -le 1 && "${1:-}" != --* ]] || fail 'Run Flockbot setup with no argument or a pinned local runtime ZIP.'

umask 077
[[ -x /usr/bin/lockf ]] || fail 'This Mac lacks the system lockf utility required for safe setup. Contact your administrator.'
check_path "$flockbot_base/.setup-stages"
mkdir -p "$flockbot_base/runtimes" "$flockbot_base/.setup-stages"
chmod 700 "$flockbot_base" "$flockbot_base/runtimes" "$flockbot_base/.setup-stages"
flockbot_lock="$flockbot_base/.setup.lock"
[[ ! -L "$flockbot_lock" && ( ! -e "$flockbot_lock" || ( -f "$flockbot_lock" && "$(stat -f %l "$flockbot_lock")" == 1 ) ) ]] || fail 'A foreign file conflicts with the Flockbot setup lock. Contact your administrator.'
# Lock the inherited descriptor, not a PID/timestamp file. Never unlink it:
# all setup processes must lock the same inode. Children retain the descriptor
# through active work even if their calling shell is killed.
exec 9>>"$flockbot_lock"
if /usr/bin/lockf -s -t 120 9; then
  :
else
  flockbot_lock_status=$?
  if [[ "$flockbot_lock_status" == 75 ]]; then
    fail 'Another Flockbot setup is still running. Wait for it to finish, then rerun setup.'
  fi
  fail 'Flockbot could not acquire its setup lock. Use a writable local install directory and ask your administrator to check system lockf descriptor support.'
fi

# Only the lock holder creates stages. Its inherited lock outlives active work,
# so a marked stage left by a previous holder is now safe to recover.
for flockbot_old in "$flockbot_base"/.setup-stages/stage.*; do
  if [[ -d "$flockbot_old" && ! -L "$flockbot_old" && -f "$flockbot_old/.owner" && ! -L "$flockbot_old/.owner" && "$(cat "$flockbot_old/.owner")" == 'flockbot-setup-stage-v1' ]]; then
    rm -rf -- "$flockbot_old"
  fi
done
if ! ready; then
  flockbot_repair=absent
  if [[ -e "$flockbot_runtime" ]]; then
    [[ ! -e "$flockbot_runtime/.complete" && ! -L "$flockbot_runtime/.complete" ]] || fail 'The Flockbot runtime has a damaged completion marker. Nothing was replaced; contact your administrator or choose a separate install root.'
    if [[ -f "$flockbot_runtime/.flockbot-runtime" && ! -L "$flockbot_runtime/.flockbot-runtime" && "$(cat "$flockbot_runtime/.flockbot-runtime")" == "$flockbot_identity" ]]; then
      flockbot_repair=owned
    else
      # Original installers had no ownership receipt. Verify every remaining
      # file against the pinned payload before treating such a target as ours.
      flockbot_repair=legacy
    fi
  fi
  flockbot_stage="$(mktemp -d "$flockbot_base/.setup-stages/stage.XXXXXX")"
  echo 'flockbot-setup-stage-v1' > "$flockbot_stage/.owner"
  trap 'rm -rf -- "$flockbot_stage"' EXIT
  flockbot_archive="$flockbot_stage/runtime.zip"
  if [[ -n "${1:-}" ]]; then
    cp -- "$1" "$flockbot_archive" 2>/dev/null || fail 'The local Flockbot archive could not be read. Check access and rerun setup.'
  else
    curl --silent --fail --location --proto '=https' --proto-redir '=https' \
      --connect-timeout 15 --max-time 180 \
      "https://github.com/askmyparish/flockbot/releases/download/mcp-v$flockbot_version/flockbot-codex-$flockbot_version-$flockbot_target.zip" \
      --output "$flockbot_archive" 2>/dev/null || fail 'Flockbot download failed or timed out. Check your network and rerun setup.'
  fi
  flockbot_actual="$(shasum -a 256 "$flockbot_archive" | cut -d ' ' -f 1)"
  [[ "$flockbot_actual" == "$flockbot_digest" ]] || fail 'Flockbot download failed its integrity check. Rerun setup with the published release.'
  # Reject traversal and non-file ZIP entries before extraction, even for a
  # mistakenly prepared/pinned archive. No payload program has run yet.
  unzip -Z1 "$flockbot_archive" > "$flockbot_stage/entries" 2>/dev/null || fail 'The Flockbot archive is invalid. Obtain the published release and rerun setup.'
  awk -F/ ' /\\/ || /^\// {exit 1} {for(i=1;i<=NF;i++) if($i==".." || $i=="." || ($i=="" && i<NF)) exit 1} END {if(NR==0) exit 1}' "$flockbot_stage/entries" || fail 'The Flockbot archive contains unsafe paths.'
  unzip -Z -l "$flockbot_archive" > "$flockbot_stage/types" 2>/dev/null || fail 'The Flockbot archive is invalid.'
  ! awk '/^[lbcps]/ {found=1} END {exit !found}' "$flockbot_stage/types" || fail 'The Flockbot archive contains unsupported file types.'
  mkdir "$flockbot_stage/payload"
  unzip -q "$flockbot_archive" -d "$flockbot_stage/payload" 2>/dev/null || fail 'Flockbot extraction failed. Check available disk space and rerun setup.'
  valid_payload "$flockbot_stage/payload" && [[ ! -e "$flockbot_stage/payload/.complete" && ! -e "$flockbot_stage/payload/.flockbot-runtime" ]] || fail 'The prepared Flockbot runtime is invalid. Obtain the published release and rerun setup.'
  legacy_matches() {
    "$flockbot_stage/payload/node" --input-type=module -e '
      import { lstatSync, readdirSync, readFileSync } from "node:fs";
      import { join } from "node:path";
      function matches(old, prepared) {
        const a = lstatSync(old), b = lstatSync(prepared);
        if (a.isSymbolicLink() || a.isDirectory() !== b.isDirectory()) return false;
        if (a.isDirectory()) return readdirSync(old).every(name => matches(join(old, name), join(prepared, name)));
        return a.isFile() && b.isFile() && readFileSync(old).equals(readFileSync(prepared));
      }
      try { process.exitCode = matches(process.argv[1], process.argv[2]) ? 0 : 1; }
      catch { process.exitCode = 1; }
    ' "$flockbot_runtime" "$flockbot_stage/payload" >/dev/null 2>&1
  }
  if [[ "$flockbot_repair" == legacy ]]; then
    legacy_matches || fail 'The Flockbot runtime path contains unrecognized or damaged files. Nothing was replaced; contact your administrator or choose a separate install root.'
  fi
  # A shell-only cancel must reach the helper too. Wait for its supervisor to
  # stop downloader descendants; leave the marked stage for the next lock holder.
  cancel_browser_setup() {
    trap '' INT TERM HUP
    kill -TERM "$flockbot_browser_pid" 2>/dev/null || true
    wait "$flockbot_browser_pid" 2>/dev/null || true
    fail 'Flockbot browser setup was cancelled. Rerun setup.'
  }
  # If the helper itself is killed, its supervisor can still be working. Leave
  # this marked stage for the next lock holder rather than guessing it is idle.
  trap - EXIT
  FLOCKBOT_SETUP_LOCK_FD=9 "$flockbot_stage/payload/node" --disable-warning=ExperimentalWarning "$flockbot_stage/payload/setup-browser.mjs" >/dev/null 2>&1 &
  flockbot_browser_pid=$!
  trap cancel_browser_setup INT TERM HUP
  wait "$flockbot_browser_pid" || fail 'Flockbot browser setup failed or timed out. Check network, permissions and disk space, then rerun setup.'
  trap - INT TERM HUP
  trap 'rm -rf -- "$flockbot_stage"' EXIT
  valid_payload "$flockbot_stage/payload" || fail 'Flockbot browser setup left an invalid runtime. Rerun setup.'
  echo "$flockbot_identity" > "$flockbot_stage/payload/.flockbot-runtime"
  echo "$flockbot_identity" > "$flockbot_stage/payload/.complete"
  check_path "$flockbot_runtime"
  if [[ "$flockbot_repair" != absent ]]; then
    # Recheck legacy content after preparation; never delete a foreign addition.
    [[ ! -e "$flockbot_runtime/.complete" && ! -L "$flockbot_runtime/.complete" ]] || fail 'The Flockbot runtime changed during setup. Rerun setup.'
    if [[ "$flockbot_repair" == legacy ]]; then
      legacy_matches || fail 'The Flockbot runtime changed during setup. Nothing was replaced; contact your administrator.'
    else
      [[ ! -L "$flockbot_runtime/.flockbot-runtime" && "$(cat "$flockbot_runtime/.flockbot-runtime")" == "$flockbot_identity" ]] || fail 'The Flockbot runtime ownership changed during setup. Nothing was replaced; contact your administrator.'
    fi
    rm -rf -- "$flockbot_runtime"
  fi
  # renameSync cannot nest a payload if a destination appears unexpectedly.
  [[ ! -e "$flockbot_runtime" && ! -L "$flockbot_runtime" ]] || fail 'The Flockbot runtime path changed during setup. Rerun setup.'
  "$flockbot_stage/payload/node" --input-type=module -e 'import { renameSync } from "node:fs"; renameSync(process.argv[1], process.argv[2]);' "$flockbot_stage/payload" "$flockbot_runtime" 2>/dev/null || fail 'Flockbot activation failed. Check disk space and permissions, then rerun setup.'
fi
ready || fail 'Flockbot setup did not complete. Rerun the plugin setup skill.'
echo 'Flockbot runtime is ready. Restart the MCP connection or start a new Codex conversation, then use connect.'
