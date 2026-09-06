#!/usr/bin/env bash
# Bump the app version across all packaging files before tagging a release.
# Usage: ./scripts/bump-version.sh 0.2.0
set -euo pipefail

NEW="${1:?usage: scripts/bump-version.sh X.Y.Z}"
cd "$(dirname "$0")/.."

sed -i -E "s/\"version\": \"[0-9]+\.[0-9]+\.[0-9]+\"/\"version\": \"$NEW\"/" homely/package.json
sed -i -E "s/\"version\": \"[0-9]+\.[0-9]+\.[0-9]+\"/\"version\": \"$NEW\"/" homely/src-tauri/tauri.conf.json
sed -i -E "s/^version = \"[0-9]+\.[0-9]+\.[0-9]+\"/version = \"$NEW\"/" homely/src-tauri/Cargo.toml
sed -i -E "s/^version: '[0-9]+\.[0-9]+\.[0-9]+'/version: '$NEW'/" snap/snapcraft.yaml

echo "Bumped to $NEW."
echo "Also update <release version=\"$NEW\" date=\"YYYY-MM-DD\"/> in"
echo "  flatpak/com.house-designer.homely.metainfo.xml"
echo "and the homepage URL in that file + the Flathub repo id."
