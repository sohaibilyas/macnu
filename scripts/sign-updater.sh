#!/bin/sh
set -eu

PROJECT_ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
TAURI_CLI="$PROJECT_ROOT/node_modules/.bin/tauri"
VERSION="$(node "$PROJECT_ROOT/scripts/release-preflight.mjs" --print-version)"
ARCHIVE_PATH="$PROJECT_ROOT/src-tauri/target/universal-apple-darwin/release/bundle/macos/Macnu.app.tar.gz"
SIGNATURE_PATH="$ARCHIVE_PATH.sig"

if [ ! -x "$TAURI_CLI" ]; then
  echo "Tauri CLI is not installed. Run 'npm install' first." >&2
  exit 1
fi
if [ ! -f "$ARCHIVE_PATH" ]; then
  echo "Build and verify the unsigned official updater archive first." >&2
  exit 1
fi

UPDATER_KEY_VALUE="${TAURI_SIGNING_PRIVATE_KEY:-}"
UPDATER_KEY_PATH="${TAURI_SIGNING_PRIVATE_KEY_PATH:-}"
UPDATER_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"
unset TAURI_SIGNING_PRIVATE_KEY
unset TAURI_SIGNING_PRIVATE_KEY_PATH
unset TAURI_SIGNING_PRIVATE_KEY_PASSWORD

if [ -z "$UPDATER_KEY_VALUE" ] && [ -z "$UPDATER_KEY_PATH" ]; then
  echo "Updater signing requires TAURI_SIGNING_PRIVATE_KEY or TAURI_SIGNING_PRIVATE_KEY_PATH." >&2
  exit 1
fi
if [ -z "$UPDATER_PASSWORD" ]; then
  echo "Updater signing requires TAURI_SIGNING_PRIVATE_KEY_PASSWORD." >&2
  exit 1
fi

rm -f "$SIGNATURE_PATH"
if [ -n "$UPDATER_KEY_VALUE" ]; then
  TAURI_SIGNING_PRIVATE_KEY="$UPDATER_KEY_VALUE" \
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$UPDATER_PASSWORD" \
    "$TAURI_CLI" signer sign "$ARCHIVE_PATH"
else
  TAURI_SIGNING_PRIVATE_KEY_PATH="$UPDATER_KEY_PATH" \
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$UPDATER_PASSWORD" \
    "$TAURI_CLI" signer sign "$ARCHIVE_PATH"
fi
unset UPDATER_KEY_VALUE
unset UPDATER_KEY_PATH
unset UPDATER_PASSWORD

test -s "$SIGNATURE_PATH"
cargo run \
  --quiet \
  --locked \
  --manifest-path "$PROJECT_ROOT/tools/release-verifier/Cargo.toml" \
  -- \
  --signature-only \
  "$ARCHIVE_PATH" \
  "$SIGNATURE_PATH"

echo "Signed Macnu updater archive for v$VERSION."
