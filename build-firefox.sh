#!/bin/sh
# Assembles a Firefox-loadable copy of the extension: same source files,
# swapping in the Firefox manifest (Firefox's MV3 background model differs
# from Chrome's, so the two can't share one manifest.json).
set -e
cd "$(dirname "$0")"
rm -rf dist-firefox
mkdir -p dist-firefox
cp -r background.js popup.html popup.css popup.js lib icons data dist-firefox/
cp manifest.firefox.json dist-firefox/manifest.json
echo "Built dist-firefox/ — in Firefox, open about:debugging#/runtime/this-firefox, click \"Load Temporary Add-on\", and select dist-firefox/manifest.json"
