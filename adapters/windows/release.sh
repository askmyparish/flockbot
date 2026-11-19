#!/usr/bin/env bash
# Publishes a Flockbot for Windows update from a clean checkout of a commit on
# main: builds the x64 and Arm builds, packs each with Velopack's vpk, saves
# them in a release of their own, then updates the feed release that
# installed copies check, along with the setup programs for new installs.
#
#   adapters/windows/release.sh [--dry-run]
#
# Needs the .NET SDK, Bun and vpk (dotnet tool install -g vpk, the same
# version as the Velopack package in Flockbot.csproj). The builds are not
# signed yet, so Windows warns before running the setup program.
#
# --dry-run writes the packages to build/release without uploading, and
# accepts a dirty tree.
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

if ! $dry_run; then
  [[ -z "$(git -C "$root" status --porcelain)" ]] ||
    fail "Commit or stash your changes first, so the release matches a commit."
  git -C "$root" fetch --quiet origin main
  git -C "$root" merge-base --is-ancestor HEAD origin/main ||
    fail "Release from a commit that's already on origin/main."
  if gh release view "$tag" --repo "$repo" > /dev/null 2>&1; then
    fail "$tag is already released. Bump the version first."
  fi
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
    --outputDir "$out" > "$out/vpk-$arch.log"
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
  --title "Flockbot for Windows $version" --notes "Flockbot for Windows $version." \
  --latest=false
if ! gh release view "$feed_tag" --repo "$repo" > /dev/null 2>&1; then
  gh release create "$feed_tag" --repo "$repo" --target "$head" \
    --title "Flockbot for Windows" --latest=false \
    --notes "Download Flockbot-win-x64-Setup.exe to install Flockbot for Windows, or Flockbot-win-arm64-Setup.exe on a Windows on Arm computer. Installed copies update themselves from this release."
fi
gh release upload "$feed_tag" "${packages[@]}" --repo "$repo" --clobber
gh release upload "$feed_tag" "${feeds[@]}" "${setups[@]}" --repo "$repo" --clobber
echo "Released Flockbot for Windows $version."
