#!/bin/sh
set -eu

PROJECT_ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
TAURI_CLI="$PROJECT_ROOT/node_modules/.bin/tauri"

if [ ! -x "$TAURI_CLI" ]; then
  echo "Tauri CLI is not installed. Run 'npm install' first." >&2
  exit 1
fi

if [ "$#" -eq 0 ]; then
  exec "$TAURI_CLI" --help
fi

COMMAND="$1"
shift

cd "$PROJECT_ROOT"
case "$COMMAND" in
  dev|build)
    # Source builds always opt in explicitly. Passing official-distribution as
    # an additional feature will hit the Rust mutual-exclusion compile guard.
    exec "$TAURI_CLI" "$COMMAND" --features source-build "$@"
    ;;
  *)
    exec "$TAURI_CLI" "$COMMAND" "$@"
    ;;
esac
