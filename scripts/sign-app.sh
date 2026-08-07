#!/bin/sh
set -eu

APP_PATH="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)/src-tauri/target/release/bundle/macos/Macnu.app"

codesign \
  --force \
  --deep \
  --sign - \
  --options runtime \
  --requirements '=designated => identifier "com.qoest.macnu"' \
  "$APP_PATH"

codesign --verify --deep --strict "$APP_PATH"
