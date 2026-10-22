#!/usr/bin/env bash
# Installs (or reinstalls) the latest kubedeck release on macOS or Linux.
# The repository is private, so this needs the GitHub CLI logged in with access to it:
#
#   gh api repos/cardoso010/kubedeck/contents/scripts/install.sh -H "Accept: application/vnd.github.raw" | bash
#
# After that, the app updates itself. On Windows, use scripts/install.ps1 instead.
set -euo pipefail

REPO="${KUBEDECK_REPO:-cardoso010/kubedeck}"

die() { echo "kubedeck install: $*" >&2; exit 1; }

command -v gh >/dev/null || die "install the GitHub CLI first: https://cli.github.com"
gh auth status >/dev/null 2>&1 || die "log in to GitHub first: gh auth login"

tag="$(gh release view --repo "$REPO" --json tagName --jq .tagName)" || die "no release found in $REPO (or no access to it)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

install_macos() {
  case "$(uname -m)" in
    arm64) arch=aarch64 ;;
    x86_64) arch=x86_64 ;;
    *) die "unsupported CPU $(uname -m)" ;;
  esac
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
}

install_linux() {
  [[ "$(uname -m)" == "x86_64" ]] || die "only x86_64 Linux builds are published"
  echo "Downloading kubedeck $tag (Linux AppImage)..."
  gh release download "$tag" --repo "$REPO" --pattern "kubedeck_*_linux_x86_64.AppImage" --dir "$tmp"
  bin="$HOME/.local/bin"
  mkdir -p "$bin" "$HOME/.local/share/applications"
  # A stable path: the in-app updater replaces this file in place.
  mv "$tmp"/kubedeck_*_linux_x86_64.AppImage "$bin/kubedeck.AppImage"
  chmod +x "$bin/kubedeck.AppImage"
  cat > "$HOME/.local/share/applications/kubedeck.desktop" <<DESKTOP
[Desktop Entry]
Name=kubedeck
Comment=Kubernetes desktop client
Exec=$bin/kubedeck.AppImage
Terminal=false
Type=Application
Categories=Development;
DESKTOP
  echo "kubedeck $tag installed in $bin/kubedeck.AppImage (also in your applications menu)"
  command -v ldconfig >/dev/null && ! ldconfig -p | grep -q libfuse.so.2 && echo "Note: AppImages need FUSE 2 (e.g. sudo apt install libfuse2)."
  return 0
}

case "$(uname -s)" in
  Darwin) install_macos ;;
  Linux) install_linux ;;
  *) die "unsupported system $(uname -s); on Windows use scripts/install.ps1" ;;
esac
