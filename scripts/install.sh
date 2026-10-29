#!/usr/bin/env bash
# Installs (or reinstalls) the latest kubedeck release on macOS or Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/cardoso010/kubedeck/main/scripts/install.sh | bash
#
# Downloads go through a logged-in GitHub CLI when there is one (needed for a private fork),
# otherwise anonymously with curl.
#
# After that, the app updates itself. On Windows, use scripts/install.ps1 instead.
set -euo pipefail

REPO="${KUBEDECK_REPO:-cardoso010/kubedeck}"

die() { echo "kubedeck install: $*" >&2; exit 1; }

if command -v gh >/dev/null && gh auth status >/dev/null 2>&1; then
  use_gh=1
  tag="$(gh release view --repo "$REPO" --json tagName --jq .tagName)" || die "no release found in $REPO (or no access to it)"
else
  use_gh=0
  command -v curl >/dev/null || die "install curl (or the GitHub CLI) first"
  tag="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n1)"
  [[ -n "$tag" ]] || die "no release found in $REPO (if it is private, log in with: gh auth login)"
fi
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# download <asset name>: saves it in $tmp.
download() {
  if [[ $use_gh == 1 ]]; then
    gh release download "$tag" --repo "$REPO" --pattern "$1" --dir "$tmp"
  else
    curl -fL --progress-bar -o "$tmp/$1" "https://github.com/$REPO/releases/download/$tag/$1"
  fi
}
version="${tag#v}"

install_macos() {
  case "$(uname -m)" in
    arm64) arch=aarch64 ;;
    x86_64) arch=x86_64 ;;
    *) die "unsupported CPU $(uname -m)" ;;
  esac
  echo "Downloading kubedeck $tag ($arch)..."
  download "kubedeck_${version}_${arch}.app.tar.gz"
  tar -xzf "$tmp/kubedeck_${version}_${arch}.app.tar.gz" -C "$tmp"
  [[ -d "$tmp/kubedeck.app" ]] || die "the download did not contain kubedeck.app"

  dest=/Applications
  [[ -w "$dest" ]] || dest="$HOME/Applications"
  mkdir -p "$dest"
  osascript -e 'quit app "kubedeck"' >/dev/null 2>&1 || true
  rm -rf "$dest/kubedeck.app"
  mv "$tmp/kubedeck.app" "$dest/"
  # The build is not notarized yet: clear the quarantine flag so Gatekeeper lets it open.
  xattr -dr com.apple.quarantine "$dest/kubedeck.app" 2>/dev/null || true
  echo "kubedeck $tag installed in $dest/kubedeck.app"
  open "$dest/kubedeck.app"
}

install_linux() {
  [[ "$(uname -m)" == "x86_64" ]] || die "only x86_64 Linux builds are published"
  echo "Downloading kubedeck $tag (Linux AppImage)..."
  download "kubedeck_${version}_linux_x86_64.AppImage"
  bin="$HOME/.local/bin"
  mkdir -p "$bin" "$HOME/.local/share/applications"
  # A stable path: the in-app updater replaces this file in place.
  mv "$tmp/kubedeck_${version}_linux_x86_64.AppImage" "$bin/kubedeck.AppImage"
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
