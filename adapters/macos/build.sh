#!/usr/bin/env bash
# Builds Flockbot.app: the Swift setup window plus the Bun-compiled connector
# it bundles. Signs ad hoc unless FLOCKBOT_SIGN_IDENTITY names a Developer ID
# Application certificate.
set -euo pipefail

# Where installed copies look for updates, and the public half of the key that
# signs them (from Sparkle's generate_keys). Without the key file the app has
# no updater.
feed="https://github.com/askmyparish/flockbot/releases/download/mac-appcast/appcast.xml"
identity="${FLOCKBOT_SIGN_IDENTITY:--}"

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
package="$root/adapters/macos"
app="$package/build/Flockbot.app"
version="$(node -p "require('$root/adapters/mcp/package.json').version")"
# Sparkle decides which copy is newer by CFBundleVersion. The commit count only
# grows on main, unlike the prerelease labels in the display version.
build="$(git -C "$root" rev-list --count HEAD)"

rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources" "$app/Contents/Frameworks"

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
cp -R "$package/.build/release/Sparkle.framework" "$app/Contents/Frameworks/"
cp "$package/.build/artifacts/sparkle/Sparkle/LICENSE" "$app/Contents/Resources/Sparkle-LICENSE"

updates=""
if [[ -f "$package/sparkle-public-key" ]]; then
  updates="<key>SUFeedURL</key><string>$feed</string>
  <key>SUPublicEDKey</key><string>$(tr -d '[:space:]' < "$package/sparkle-public-key")</string>
  <key>SUEnableAutomaticChecks</key><true/>
  <key>SUAutomaticallyUpdate</key><true/>"
fi

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
  <key>CFBundleVersion</key><string>$build</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSHumanReadableCopyright</key><string>Independent; not affiliated with Flocknote.</string>
  $updates
</dict>
</plist>
PLIST

# Inner code first, then the bundle that seals it. Sparkle's helpers and the
# connector always use the hardened runtime that notarization requires, so the
# connector's JIT entitlement is exercised in every build; only the outer app
# of an ad hoc build goes without it (see below). Sparkle's helpers are
# re-signed in the order its documentation gives.
# Notarization needs a secure timestamp, which ad hoc signatures can't carry.
timestamp="--timestamp"
[[ "$identity" == "-" ]] && timestamp="--timestamp=none"
sign() { codesign --force --sign "$identity" --options runtime "$timestamp" "$@"; }
sparkle="$app/Contents/Frameworks/Sparkle.framework/Versions/B"
sign "$sparkle/XPCServices/Installer.xpc"
sign --preserve-metadata=entitlements "$sparkle/XPCServices/Downloader.xpc"
sign "$sparkle/Autoupdate"
sign "$sparkle/Updater.app"
sign "$app/Contents/Frameworks/Sparkle.framework"
sign --entitlements "$package/flockbot-mcp.entitlements" "$app/Contents/MacOS/flockbot-mcp"
if [[ "$identity" == "-" ]]; then
  # Library validation only loads frameworks from the app's own Team ID, and
  # ad hoc signatures have none, so an ad hoc app can't load Sparkle under the
  # hardened runtime. The connector above still runs under it.
  codesign --force --sign - "$app"
else
  sign "$app"
fi
echo "$app"
