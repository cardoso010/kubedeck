#!/usr/bin/env bash
# Assembles the project page (site/) with the README screenshots and the app icon into _site/,
# which the Pages workflow publishes. Locally: scripts/build-site.sh && python3 -m http.server -d _site
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf _site
mkdir -p _site
cp -R site/. _site/
cp -R docs/screenshots _site/screenshots
cp src-tauri/icons/128x128@2x.png _site/icon.png
touch _site/.nojekyll
