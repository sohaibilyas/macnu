#!/bin/sh
set -eu

PROJECT_ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
if [ -n "${MACNU_RELEASE_TAG:-}" ]; then
  VERSION="$(node "$PROJECT_ROOT/scripts/release-preflight.mjs" \
    --tag "$MACNU_RELEASE_TAG" \
    --print-version)"
else
  VERSION="$(node "$PROJECT_ROOT/scripts/release-preflight.mjs" --print-version)"
fi
TAG="v$VERSION"
BUNDLE_ROOT="$PROJECT_ROOT/src-tauri/target/universal-apple-darwin/release/bundle"
DMG_NAME="Macnu_${VERSION}_universal.dmg"
DMG_PATH="$BUNDLE_ROOT/dmg/$DMG_NAME"
ARCHIVE_PATH="$BUNDLE_ROOT/macos/Macnu.app.tar.gz"
SIGNATURE_PATH="$ARCHIVE_PATH.sig"
RELEASE_ROOT="$PROJECT_ROOT/src-tauri/target/release-assets"
RELEASE_DIR="$RELEASE_ROOT/$TAG"

"$PROJECT_ROOT/scripts/verify-official.sh" "$VERSION"

case "$RELEASE_DIR" in
  "$PROJECT_ROOT/src-tauri/target/release-assets/v"*) ;;
  *) echo "Refusing unsafe release output path." >&2; exit 1 ;;
esac
rm -rf "$RELEASE_DIR"
mkdir -p "$RELEASE_DIR"

install -m 0644 "$DMG_PATH" "$RELEASE_DIR/$DMG_NAME"
install -m 0644 "$ARCHIVE_PATH" "$RELEASE_DIR/Macnu.app.tar.gz"
install -m 0644 "$SIGNATURE_PATH" "$RELEASE_DIR/Macnu.app.tar.gz.sig"

node "$PROJECT_ROOT/scripts/generate-update-manifest.mjs" \
  "$VERSION" \
  "$RELEASE_DIR/Macnu.app.tar.gz.sig" \
  "$RELEASE_DIR/latest.json"
node "$PROJECT_ROOT/scripts/verify-update-manifest.mjs" \
  "$VERSION" \
  "$RELEASE_DIR/Macnu.app.tar.gz.sig" \
  "$RELEASE_DIR/latest.json"

(
  cd "$RELEASE_DIR"
  shasum -a 256 \
    "$DMG_NAME" \
    "Macnu.app.tar.gz" \
    "Macnu.app.tar.gz.sig" \
    "latest.json" > SHA256SUMS.txt
)

echo "Release assets ready at $RELEASE_DIR"
