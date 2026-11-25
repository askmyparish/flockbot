#!/usr/bin/env bash
# Publishes a Flockbot for Windows update from a clean checkout of a commit on
# main: builds the x64 and Arm builds, packs each with Velopack's vpk, saves
# them in a release of their own, then updates the feed release that
# installed copies check, along with the setup programs for new installs.
#
#   FLOCKBOT_SIGNING_ACCOUNT=phad-signing \
#   FLOCKBOT_SIGNING_PROFILE=flockbot \
#   adapters/windows/release.sh [--dry-run]
#
# Needs the .NET SDK, Bun and vpk (dotnet tool install -g vpk, the same
# version as the Velopack package in Flockbot.csproj). vpk signs every program
# it packs, its own Setup.exe and Update.exe included, with Azure Artifact
# Signing through jsign (brew install jsign), using an access token from the
# Azure CLI (brew install azure-cli, then az login). The two settings name
# the Artifact Signing account and its certificate profile;
# FLOCKBOT_SIGNING_ENDPOINT is the account's regional endpoint, East US by
# default.
#
# If a release stops partway, run it again from the same commit: it starts
# over when the version's release is still a draft, and otherwise finishes the
# feed from the files that release already published. It refuses to replace a
# feed that already offers a newer version.
#
# --dry-run writes the packages to build/release without uploading, accepts a
# dirty tree, and leaves them unsigned unless the signing settings are set.
set -euo pipefail

repo="askmyparish/flockbot"
# The release Flockbot.csproj names as the update feed.
feed_tag="windows-feed"

dry_run=false
if [[ "${1:-}" == "--dry-run" ]]; then dry_run=true; fi

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
package="$root/adapters/windows"
out="$package/build/release"
version="$(node -p "require('$root/adapters/mcp/package.json').version")"
tag="win-v$version"

fail() {
  echo "$*" >&2
  exit 1
}

signing=false
if [[ -n "${FLOCKBOT_SIGNING_ACCOUNT:-}${FLOCKBOT_SIGNING_PROFILE:-}" ]] || ! $dry_run; then
  signing=true
fi

resume=false
if ! $dry_run; then
  # build.sh would bake the test feed into the release, and installed copies
  # would stop getting updates.
  [[ -z "${FLOCKBOT_UPDATE_FEED:-}" ]] ||
    fail "Unset FLOCKBOT_UPDATE_FEED first; it's only for test builds."
  [[ -z "$(git -C "$root" status --porcelain)" ]] ||
    fail "Commit or stash your changes first, so the release matches a commit."
  git -C "$root" fetch --quiet origin main
  git -C "$root" merge-base --is-ancestor HEAD origin/main ||
    fail "Release from a commit that's already on origin/main."
  # A release that stopped partway left either a draft, which is started over,
  # or a published version whose feed may not have been updated, which is
  # finished from the files it already published.
  if [[ "$(gh release view "$tag" --repo "$repo" --json isDraft --jq .isDraft 2> /dev/null)" == "true" ]]; then
    gh release delete "$tag" --repo "$repo" --yes
  elif gh release view "$tag" --repo "$repo" > /dev/null 2>&1; then
    [[ "$(git -C "$root" ls-remote origin "refs/tags/$tag" | cut -f1)" == "$(git -C "$root" rev-parse HEAD)" ]] ||
      fail "$tag is already released. Bump the version first."
    resume=true
  fi
  # The version's reviewed changelog section, from the release PR.
  notes="$(cd "$root" && node scripts/mcp/release-notes.mjs)" ||
    fail "adapters/mcp/CHANGELOG.md has no entry for $version. Merge the release PR first."
fi

sign=()
if $signing && ! $resume; then
  [[ -n "${FLOCKBOT_SIGNING_ACCOUNT:-}" && -n "${FLOCKBOT_SIGNING_PROFILE:-}" ]] ||
    fail "Set FLOCKBOT_SIGNING_ACCOUNT and FLOCKBOT_SIGNING_PROFILE to your Artifact Signing account and certificate profile."
  command -v jsign > /dev/null || fail "Install jsign first: brew install jsign"
  command -v az > /dev/null || fail "Install the Azure CLI first: brew install azure-cli"
  # jsign reads the token from the environment, so it never appears in a
  # command line or in vpk's log.
  FLOCKBOT_SIGNING_TOKEN="$(az account get-access-token --resource https://codesigning.azure.net \
    --query accessToken --output tsv)" || fail "Sign in to Azure first: az login"
  export FLOCKBOT_SIGNING_TOKEN
  # vpk runs this through bash -c "…", so it can't contain double quotes.
  # One jsign call per batch of files keeps Artifact Signing's quota use down.
  sign=(--signTemplate "jsign --storetype TRUSTEDSIGNING \
--keystore ${FLOCKBOT_SIGNING_ENDPOINT:-eus.codesigning.azure.net} \
--storepass env:FLOCKBOT_SIGNING_TOKEN \
--alias $FLOCKBOT_SIGNING_ACCOUNT/$FLOCKBOT_SIGNING_PROFILE \
--tsaurl http://timestamp.acs.microsoft.com --tsmode RFC3161 {{file...}}")
fi

rm -rf "$out"
mkdir -p "$out"
if $resume; then
  echo "$tag is published; finishing its feed from the files it published."
  gh release download "$tag" --repo "$repo" --dir "$out"
else
  for arch in x64 arm64; do
    "$package/build.sh" "$arch" > /dev/null
    # Each architecture is its own channel, so an install only ever updates to
    # its own kind of build.
    vpk "[win]" pack --packId Flockbot --packTitle Flockbot --packAuthors "Ask My Parish" \
      --packVersion "$version" --packDir "$package/build/$arch" --mainExe Flockbot.exe \
      --runtime "win-$arch" --channel "win-$arch" --icon "$root/assets/flockbot.ico" \
      ${sign[@]+"${sign[@]}"} --outputDir "$out" > "$out/vpk-$arch.log" ||
      fail "vpk couldn't pack the $arch build. See $out/vpk-$arch.log."
  done
fi

# What gets published: the packages, the feeds that list them, and the setup
# programs. Portable zips are left out: assistants need the installed path.
packages=("$out"/*.nupkg)
feeds=("$out"/releases.*.json "$out"/assets.*.json "$out"/RELEASES-*)
setups=("$out"/*-Setup.exe)

if $dry_run; then
  echo "Dry run of $version: wrote $out. Nothing was uploaded."
  exit 0
fi

# Never point installs back at an older version, as finishing an earlier
# release after a later one would. Only a feed that doesn't exist yet skips
# the check; any other lookup failure stops the release.
if gh release view "$feed_tag" --repo "$repo" > /dev/null 2> "$out/feed.err"; then
  mkdir "$out/published"
  gh release download "$feed_tag" --repo "$repo" --pattern "releases.*.json" --dir "$out/published"
  for arch in x64 arm64; do
    published="$out/published/releases.win-$arch.json"
    [[ ! -f "$published" ]] ||
      bun "$root/scripts/mcp/check-feed.mjs" velopack "$published" "$out/releases.win-$arch.json" "$version"
  done
elif ! grep -q "release not found" "$out/feed.err"; then
  cat "$out/feed.err" >&2
  exit 1
fi
rm "$out/feed.err"

head="$(git -C "$root" rev-parse HEAD)"
# A record of this version, then the feed: packages before the lists that
# name them, so a copy never sees a version it can't download.
# The version's release is a draft until all of it is uploaded, and it keeps
# the feed's lists too, so a release that stops before the feed is updated
# can be finished.
if ! $resume; then
  gh release create "$tag" "${packages[@]}" "${setups[@]}" "${feeds[@]}" --repo "$repo" \
    --draft --target "$head" --title "Flockbot for Windows $version" --notes "$notes" \
    --latest=false
  gh release edit "$tag" --repo "$repo" --draft=false --latest=false
fi
if ! gh release view "$feed_tag" --repo "$repo" > /dev/null 2>&1; then
  gh release create "$feed_tag" --repo "$repo" --target "$head" \
    --title "Flockbot for Windows" --latest=false \
    --notes "Download Flockbot-win-x64-Setup.exe to install Flockbot for Windows, or Flockbot-win-arm64-Setup.exe on a Windows on Arm computer. Installed copies update themselves from this release."
fi
gh release upload "$feed_tag" "${packages[@]}" --repo "$repo" --clobber
gh release upload "$feed_tag" "${feeds[@]}" "${setups[@]}" --repo "$repo" --clobber
echo "Released Flockbot for Windows $version."
