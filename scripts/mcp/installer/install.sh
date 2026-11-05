#!/bin/bash
set -euo pipefail
flockbot_package="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
flockbot_route=desktop
if [[ $# == 2 && "$1" == --route && ( "$2" == tui || "$2" == desktop ) ]]; then
  flockbot_route="$2"
elif [[ $# != 0 ]]; then
  echo '{"schema":1,"ok":false,"code":"invalid_arguments","remaining":["correct_setup_arguments"]}'
  exit 1
fi
# All runtime/bootstrap diagnostics are fixed messages; expose a bounded result
# instead of mistaking runtime preparation for completed onboarding.
if ! /bin/bash "$flockbot_package/plugin/setup.sh" "$flockbot_package/runtime.zip" >&2; then
  echo '{"schema":1,"ok":false,"code":"runtime_preparation_failed","runtime":"not_prepared","remaining":["resolve_runtime_failure_then_retry"]}'
  exit 1
fi
flockbot_version="$(cat "$flockbot_package/plugin/runtime.version")"
flockbot_digest="$(cat "$flockbot_package/plugin/runtime.sha256")"
flockbot_base="${FLOCKBOT_INSTALL_ROOT:-$HOME/Library/Application Support/Flockbot MCP}"
flockbot_runtime="$flockbot_base/runtimes/$flockbot_version-darwin-arm64-${flockbot_digest:0:12}"
exec "$flockbot_runtime/node" --disable-warning=ExperimentalWarning "$flockbot_runtime/install-core.mjs" --plugin "$flockbot_package/plugin" --route "$flockbot_route"
