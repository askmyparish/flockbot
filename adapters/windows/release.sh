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
  if gh release view "$tag" --repo "$repo" > /dev/null 2>&1; then
    fail "$tag is already released. Bump the version first."
  fi
  # The version's reviewed changelog section, from the release PR.
  notes="$(cd "$root" && node scripts/mcp/release-notes.mjs)" ||
    fail "adapters/mcp/CHANGELOG.md has no entry for $version. Merge the release PR first."
fi

sign=()
if $signing; then
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

# What gets published: the packages, the feeds that list them, and the setup
# programs. Portable zips are left out: assistants need the installed path.
packages=("$out"/*.nupkg)
feeds=("$out"/releases.*.json "$out"/assets.*.json "$out"/RELEASES-*)
setups=("$out"/*-Setup.exe)

if $dry_run; then
  echo "Dry run of $version: wrote $out. Nothing was uploaded."
  exit 0
fi

head="$(git -C "$root" rev-parse HEAD)"
# A record of this version, then the feed: packages before the lists that
# name them, so a copy never sees a version it can't download.
gh release create "$tag" "${packages[@]}" "${setups[@]}" --repo "$repo" --target "$head" \
  --title "Flockbot for Windows $version" --notes "$notes" \
  --latest=false
if ! gh release view "$feed_tag" --repo "$repo" > /dev/null 2>&1; then
  gh release create "$feed_tag" --repo "$repo" --target "$head" \
    --title "Flockbot for Windows" --latest=false \
    --notes "Download Flockbot-win-x64-Setup.exe to install Flockbot for Windows, or Flockbot-win-arm64-Setup.exe on a Windows on Arm computer. Installed copies update themselves from this release."
fi
gh release upload "$feed_tag" "${packages[@]}" --repo "$repo" --clobber
gh release upload "$feed_tag" "${feeds[@]}" "${setups[@]}" --repo "$repo" --clobber
echo "Released Flockbot for Windows $version."
