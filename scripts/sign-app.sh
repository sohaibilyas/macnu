#!/bin/sh
set -eu

APP_PATH="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)/src-tauri/target/release/bundle/macos/Macnu.app"

if [ "${MACNU_BUILD_MODE:-}" != "source-build" ]; then
  echo "Refusing to ad-hoc sign without MACNU_BUILD_MODE=source-build." >&2
  echo "Use 'npm run build:app' for a source build or 'npm run build:official' for a Developer ID build." >&2
  exit 1
fi

if [ ! -d "$APP_PATH" ]; then
  echo "Source build not found at $APP_PATH." >&2
  exit 1
fi

codesign \
  --force \
  --deep \
  --sign - \
  --options runtime \
  --requirements '=designated => identifier "com.qoest.macnu"' \
  "$APP_PATH"

codesign --verify --deep --strict "$APP_PATH"
