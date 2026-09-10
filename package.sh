#!/bin/sh
# Packages both store submissions into dist/:
#   - a Chrome Web Store zip (manifest.json at the zip root)
#   - a Firefox AMO zip (manifest.firefox.json, renamed to manifest.json, at the zip root)
# Both are built from the same source files; only the manifest differs (Chrome's MV3
# service_worker background vs. Firefox's scripts-based one — see build-firefox.sh).
set -e
cd "$(dirname "$0")"
ROOT_DIR="$(pwd)"

VERSION=$(jq -r .version manifest.json)
SLUG="backlog-browser-for-epic-games"

rm -rf dist
mkdir -p dist

echo "Packaging v$VERSION..."

# --- Chrome ---
CHROME_STAGE=$(mktemp -d)
cp -r background.js popup.html popup.css popup.js theme-init.js lib icons data manifest.json "$CHROME_STAGE/"
(cd "$CHROME_STAGE" && zip -rq "$ROOT_DIR/dist/${SLUG}-chrome-v${VERSION}.zip" .)
rm -rf "$CHROME_STAGE"
echo "  dist/${SLUG}-chrome-v${VERSION}.zip"

# --- Firefox ---
"$ROOT_DIR/build-firefox.sh" >/dev/null
(cd "$ROOT_DIR/dist-firefox" && zip -rq "$ROOT_DIR/dist/${SLUG}-firefox-v${VERSION}.zip" .)
echo "  dist/${SLUG}-firefox-v${VERSION}.zip"

echo "Done."
