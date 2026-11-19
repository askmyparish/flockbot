#!/usr/bin/env bash
# Builds the Windows app on macOS, Linux or Windows (Git Bash) with the .NET
# SDK and Bun: a self-contained Flockbot.exe with the Bun-compiled connector
# beside it, in adapters/windows/build/<arch>/. The output is unsigned.
# FLOCKBOT_UPDATE_FEED points a test build at another update feed.
#
#   adapters/windows/build.sh [x64|arm64]
set -euo pipefail

arch="${1:-x64}"
case "$arch" in
  x64 | arm64) ;;
  *)
    echo "Usage: $0 [x64|arm64]" >&2
    exit 2
    ;;
esac

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
package="$root/adapters/windows"
out="$package/build/$arch"
# A relative path, because Windows Node can't open Git Bash's /c/... paths.
version="$(cd "$root" && node -p "require('./adapters/mcp/package.json').version")"

rm -rf "$out"
mkdir -p "$out"

# Bun leaves temporary files in its working directory; keep them out of the repo.
scratch="$(mktemp -d)"
trap 'rm -rf -- "$scratch"' EXIT
(cd "$scratch" && bun build --compile --minify --target="bun-windows-$arch" \
  --define "BUILD_LABEL=\"$version\"" \
  "$root/adapters/mcp/src/keychain-main.ts" \
  --outfile "$out/flockbot-mcp.exe" > /dev/null)

# File versions are numbers only; the full label goes in the product version.
dotnet publish "$package/Flockbot.csproj" --nologo -v quiet -c Release -r "win-$arch" \
  -p:Version="${version%%-*}" -p:InformationalVersion="$version" \
  ${FLOCKBOT_UPDATE_FEED:+-p:UpdateFeed="$FLOCKBOT_UPDATE_FEED"} -o "$out"

echo "$out"
