#!/bin/bash
set -euo pipefail
# One persistent inode, shared by desktop and TUI setup. Children
# inherit descriptor 9 so a killed parent cannot release active host work early.
fail() { echo '{"schema":1,"ok":false,"code":"coordination_failed","remaining":["resolve_coordination_then_retry"]}'; exit 1; }
[[ "$(uname -s)" == Darwin && -x /usr/bin/lockf ]] || fail
flockbot_home="${HOME:?}"
[[ "$flockbot_home" == /* ]] || fail
flockbot_path=''
IFS=/ read -r -a flockbot_parts <<< "${flockbot_home#/}"
for flockbot_part in "${flockbot_parts[@]}"; do
  [[ -n "$flockbot_part" && "$flockbot_part" != . && "$flockbot_part" != .. ]] || fail
  flockbot_path="$flockbot_path/$flockbot_part"
  [[ -d "$flockbot_path" && ! -L "$flockbot_path" ]] || fail
done
flockbot_lock="$flockbot_home/.flockbot-install.lock"
[[ ! -L "$flockbot_lock" && ( ! -e "$flockbot_lock" || ( -f "$flockbot_lock" && "$(stat -f %l "$flockbot_lock")" == 1 && "$(stat -f %u "$flockbot_lock")" == "$(id -u)" ) ) ]] || fail
umask 077
exec 9>>"$flockbot_lock"
/usr/bin/lockf -s -t 120 9 || fail
export FLOCKBOT_INSTALL_LOCK_FD=9
exec "$@"
