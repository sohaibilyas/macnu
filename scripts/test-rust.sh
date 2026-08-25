#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 source-build|official-distribution" >&2
  exit 1
fi

case "$1" in
  source-build|official-distribution) BUILD_FEATURE="$1" ;;
  *) echo "Unknown Macnu build feature: $1" >&2; exit 1 ;;
esac

PROJECT_ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"

cd "$PROJECT_ROOT"
exec env \
  DYLD_FALLBACK_LIBRARY_PATH="/usr/lib/swift" \
  cargo test --locked --manifest-path src-tauri/Cargo.toml --lib --features "$BUILD_FEATURE"
