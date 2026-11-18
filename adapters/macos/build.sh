#!/usr/bin/env bash
# Builds Flockbot.app: the Swift setup window plus the Bun-compiled connector
# it bundles. Signs ad hoc unless FLOCKBOT_SIGN_IDENTITY names a Developer ID
# Application certificate.
set -euo pipefail

identity="${FLOCKBOT_SIGN_IDENTITY:--}"

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
package="$root/adapters/macos"
app="$package/build/Flockbot.app"
version="$(node -p "require('$root/adapters/mcp/package.json').version")"

rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"

# Bun leaves temporary files in its working directory; keep them out of the repo.
scratch="$(mktemp -d)"
trap 'rm -rf -- "$scratch"' EXIT
(cd "$scratch" && bun build --compile --minify --target=bun-darwin-arm64 \
  --define "BUILD_LABEL=\"$version\"" \
  "$root/adapters/mcp/src/keychain-main.ts" \
  --outfile "$app/Contents/MacOS/flockbot-mcp" > /dev/null)

# App icon: the robot on a macOS icon plate (assets/flockbot-macos.png).
iconset="$scratch/AppIcon.iconset"
mkdir -p "$iconset"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$root/assets/flockbot-macos.png" --out "$iconset/icon_${size}x${size}.png" > /dev/null
  double=$((size * 2))
  sips -z "$double" "$double" "$root/assets/flockbot-macos.png" --out "$iconset/icon_${size}x${size}@2x.png" > /dev/null
done
iconutil -c icns "$iconset" -o "$app/Contents/Resources/AppIcon.icns"

swift build --quiet -c release --package-path "$package"
cp "$package/.build/release/Flockbot" "$app/Contents/MacOS/Flockbot"

cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>com.askmyparish.flockbot</string>
  <key>CFBundleName</key><string>Flockbot</string>
  <key>CFBundleDisplayName</key><string>Flockbot</string>
  <key>CFBundleExecutable</key><string>Flockbot</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$version</string>
  <key>CFBundleVersion</key><string>$version</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSHumanReadableCopyright</key><string>Independent; not affiliated with Flocknote.</string>
</dict>
</plist>
PLIST

# Inner code first, then the bundle that seals it. Both use the hardened
# runtime that notarization requires, so the connector's JIT entitlement is
# exercised in every build.
sign() { codesign --force --sign "$identity" --options runtime "$@"; }
sign --entitlements "$package/flockbot-mcp.entitlements" "$app/Contents/MacOS/flockbot-mcp"
sign "$app"
echo "$app"
