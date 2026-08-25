#!/bin/sh
set -eu

PROJECT_ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
VERSION="$(node "$PROJECT_ROOT/scripts/release-preflight.mjs" --print-version)"
BUNDLE_ROOT="$PROJECT_ROOT/src-tauri/target/universal-apple-darwin/release/bundle"
APP_PATH="$BUNDLE_ROOT/macos/Macnu.app"
ARCHIVE_PATH="$BUNDLE_ROOT/macos/Macnu.app.tar.gz"
SIGNATURE_PATH="$ARCHIVE_PATH.sig"
ARCHIVE_LIMIT=$((512 * 1024 * 1024))

if [ ! -d "$APP_PATH" ]; then
  echo "Official Macnu.app was not found at $APP_PATH." >&2
  exit 1
fi

case "$ARCHIVE_PATH" in
  "$PROJECT_ROOT/src-tauri/target/universal-apple-darwin/release/bundle/macos/Macnu.app.tar.gz") ;;
  *) echo "Refusing unsafe updater archive path." >&2; exit 1 ;;
esac

TEMPORARY_ROOT="$(mktemp -d /tmp/macnu-updater-archive.XXXXXX)"
cleanup() {
  rm -rf "$TEMPORARY_ROOT"
}
trap cleanup EXIT HUP INT TERM
TEMPORARY_ARCHIVE="$TEMPORARY_ROOT/Macnu.app.tar.gz"

COPYFILE_DISABLE=1 /usr/bin/tar \
  --no-xattrs \
  -czf "$TEMPORARY_ARCHIVE" \
  -C "$BUNDLE_ROOT/macos" \
  Macnu.app

ARCHIVE_SIZE="$(stat -f '%z' "$TEMPORARY_ARCHIVE")"
if [ "$ARCHIVE_SIZE" -le 0 ] || [ "$ARCHIVE_SIZE" -gt "$ARCHIVE_LIMIT" ]; then
  echo "Updater archive size is outside Macnu's allowed range." >&2
  exit 1
fi

install -m 0644 "$TEMPORARY_ARCHIVE" "$ARCHIVE_PATH"
rm -f "$SIGNATURE_PATH"
trap - EXIT HUP INT TERM
cleanup

echo "Created unsigned Macnu updater archive for v$VERSION."
