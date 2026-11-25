#!/usr/bin/env bash
# Publishes a Flockbot.app update from a clean checkout of a commit on main:
# builds, signs and notarizes the app, uploads its zip to a release of its own,
# then updates the appcast that installed copies check, along with the
# Flockbot.zip download link for new installs.
#
#   FLOCKBOT_SIGN_IDENTITY="Developer ID Application: Name (TEAMID)" \
#   FLOCKBOT_NOTARY_PROFILE=flockbot \
#   adapters/macos/release.sh
#
# FLOCKBOT_NOTARY_PROFILE names credentials saved with
# `xcrun notarytool store-credentials`. Sparkle's generate_appcast signs the
# update with the private key generate_keys saved in the login Keychain, or
# with the key file in SPARKLE_ED_KEY_FILE.
#
# --dry-run writes the zip and appcast to build/release without notarizing or
# uploading, and accepts a dirty tree and an ad hoc signature.
set -euo pipefail

repo="askmyparish/flockbot"
# The release whose appcast.xml build.sh names as the feed.
feed_tag="mac-appcast"

dry_run=false
if [[ "${1:-}" == "--dry-run" ]]; then dry_run=true; fi

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
package="$root/adapters/macos"
app="$package/build/Flockbot.app"
out="$package/build/release"
version="$(node -p "require('$root/adapters/mcp/package.json').version")"
tag="mac-v$version"

fail() {
  echo "$*" >&2
  exit 1
}

[[ -f "$package/sparkle-public-key" ]] ||
  fail "Save the public key from Sparkle's generate_keys in adapters/macos/sparkle-public-key first. Without it the app can't receive updates."
if ! $dry_run; then
  # build.sh would bake the test feed into the release, and installed copies
  # would stop getting updates.
  [[ -z "${FLOCKBOT_UPDATE_FEED:-}" ]] ||
    fail "Unset FLOCKBOT_UPDATE_FEED first; it's only for test builds."
  [[ "${FLOCKBOT_SIGN_IDENTITY:-}" == "Developer ID Application:"* ]] ||
    fail "Set FLOCKBOT_SIGN_IDENTITY to your Developer ID Application certificate."
  [[ -n "${FLOCKBOT_NOTARY_PROFILE:-}" ]] ||
    fail "Set FLOCKBOT_NOTARY_PROFILE to a profile saved with xcrun notarytool store-credentials."
  [[ -z "$(git -C "$root" status --porcelain)" ]] ||
    fail "Commit or stash your changes first, so the release matches a commit."
  git -C "$root" fetch --quiet origin main
  git -C "$root" merge-base --is-ancestor HEAD origin/main ||
    fail "Release from a commit that's already on origin/main."
  if gh release view "$tag" --repo "$repo" > /dev/null 2>&1; then
    fail "$tag is already released. Bump the version first."
  fi
  # The version's reviewed changelog section, from the release PR.
  notes="$(cd "$root" && node scripts/mcp/release-notes.mjs)" ||
    fail "adapters/mcp/CHANGELOG.md has no entry for $version. Merge the release PR first."
fi

"$package/build.sh" > /dev/null
build="$(/usr/libexec/PlistBuddy -c "Print :CFBundleVersion" "$app/Contents/Info.plist")"

rm -rf "$out"
mkdir -p "$out"
zip="$out/Flockbot-$version.zip"
archive() { ditto -c -k --sequesterRsrc --keepParent "$app" "$zip"; }
archive

if ! $dry_run; then
  # notarytool can finish without error for a rejected upload, so check the status.
  xcrun notarytool submit "$zip" --keychain-profile "$FLOCKBOT_NOTARY_PROFILE" \
    --wait --output-format json > "$out/notarization.json"
  status="$(plutil -extract status raw -o - "$out/notarization.json")"
  [[ "$status" == "Accepted" ]] ||
    fail "Notarization finished as $status. See xcrun notarytool log with the id in $out/notarization.json."
  # Staple the ticket so the app opens without a network check, then zip it again.
  xcrun stapler staple "$app"
  spctl --assess --type execute -vv "$app"
  rm "$zip"
  archive
fi

# generate_appcast adds the new zip to the published appcast and keeps its
# earlier entries. Starting a fresh appcast would drop those entries, so that
# only happens when the feed's release doesn't exist yet.
if gh release view "$feed_tag" --repo "$repo" > /dev/null 2> "$out/feed.err"; then
  gh release download "$feed_tag" --repo "$repo" --pattern appcast.xml --dir "$out"
elif grep -q "release not found" "$out/feed.err"; then
  echo "No appcast is published yet; starting one."
else
  cat "$out/feed.err" >&2
  exit 1
fi
rm "$out/feed.err"

key=()
if [[ -n "${SPARKLE_ED_KEY_FILE:-}" ]]; then key=(--ed-key-file "$SPARKLE_ED_KEY_FILE"); fi
"$package/.build/artifacts/sparkle/Sparkle/bin/generate_appcast" ${key[@]+"${key[@]}"} \
  --download-url-prefix "https://github.com/$repo/releases/download/$tag/" \
  --link "https://github.com/$repo" "$out"
cp "$zip" "$out/Flockbot.zip"

if $dry_run; then
  echo "Dry run of $version (build $build): wrote $out. Nothing was uploaded."
  exit 0
fi

# The update first, then the appcast that points at it.
gh release create "$tag" "$zip" --repo "$repo" --target "$(git -C "$root" rev-parse HEAD)" \
  --title "Flockbot for Mac $version" --notes "$notes" \
  --latest=false
if ! gh release view "$feed_tag" --repo "$repo" > /dev/null 2>&1; then
  gh release create "$feed_tag" --repo "$repo" --target "$(git -C "$root" rev-parse HEAD)" \
    --title "Flockbot for Mac" --latest=false \
    --notes "Download Flockbot.zip to install Flockbot for Mac. Installed copies update themselves from appcast.xml."
fi
gh release upload "$feed_tag" "$out/appcast.xml" "$out/Flockbot.zip" --repo "$repo" --clobber
echo "Released Flockbot for Mac $version (build $build)."
