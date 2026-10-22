#!/usr/bin/env bash
# Installs (or reinstalls) the latest kubedeck release on macOS.
# The repository is private, so this needs the GitHub CLI logged in with access to it:
#
#   gh api repos/cardoso010/kubedeck/contents/scripts/install.sh -H "Accept: application/vnd.github.raw" | bash
#
# After that, the app updates itself.
set -euo pipefail

REPO="${KUBEDECK_REPO:-cardoso010/kubedeck}"

die() { echo "kubedeck install: $*" >&2; exit 1; }

[[ "$(uname -s)" == "Darwin" ]] || die "only macOS builds are published"
command -v gh >/dev/null || die "install the GitHub CLI first: brew install gh"
gh auth status >/dev/null 2>&1 || die "log in to GitHub first: gh auth login"

case "$(uname -m)" in
  arm64) arch=aarch64 ;;
  x86_64) arch=x86_64 ;;
  *) die "unsupported CPU $(uname -m)" ;;
esac

tag="$(gh release view --repo "$REPO" --json tagName --jq .tagName)" || die "no release found in $REPO (or no access to it)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "Downloading kubedeck $tag ($arch)..."
gh release download "$tag" --repo "$REPO" --pattern "kubedeck_*_${arch}.app.tar.gz" --dir "$tmp"
tar -xzf "$tmp"/kubedeck_*_"${arch}".app.tar.gz -C "$tmp"
[[ -d "$tmp/kubedeck.app" ]] || die "the download did not contain kubedeck.app"

dest=/Applications
[[ -w "$dest" ]] || dest="$HOME/Applications"
mkdir -p "$dest"

osascript -e 'quit app "kubedeck"' >/dev/null 2>&1 || true
rm -rf "$dest/kubedeck.app"
mv "$tmp/kubedeck.app" "$dest/"
# The build is not notarized yet; files from gh carry no quarantine flag, but clear it anyway.
xattr -dr com.apple.quarantine "$dest/kubedeck.app" 2>/dev/null || true

echo "kubedeck $tag installed in $dest/kubedeck.app"
open "$dest/kubedeck.app"
