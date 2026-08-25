#!/bin/sh
set -eu

PROJECT_ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
TAURI_CLI="$PROJECT_ROOT/node_modules/.bin/tauri"

if [ ! -x "$TAURI_CLI" ]; then
  echo "Tauri CLI is not installed. Run 'npm install' first." >&2
  exit 1
fi

set --
if [ -n "${MACNU_RELEASE_TAG:-}" ]; then
  set -- "$@" --tag "$MACNU_RELEASE_TAG"
fi
if [ "${MACNU_REQUIRE_CLEAN:-0}" = "1" ]; then
  set -- "$@" --require-clean
fi
node "$PROJECT_ROOT/scripts/release-preflight.mjs" "$@"

if [ "${MACNU_SKIP_FRONTEND_BUILD:-0}" != "1" ]; then
  (
    unset APPLE_CERTIFICATE
    unset APPLE_CERTIFICATE_PASSWORD
    unset APPLE_PASSWORD
    unset APPLE_API_PRIVATE_KEY
    unset TAURI_SIGNING_PRIVATE_KEY
    unset TAURI_SIGNING_PRIVATE_KEY_PATH
    unset TAURI_SIGNING_PRIVATE_KEY_PASSWORD
    cd "$PROJECT_ROOT"
    npm run build
  )
fi

if [ -z "${APPLE_SIGNING_IDENTITY:-}" ] && [ -z "${APPLE_CERTIFICATE:-}" ]; then
  echo "Official build requires APPLE_SIGNING_IDENTITY or APPLE_CERTIFICATE." >&2
  exit 1
fi

if [ -n "${APPLE_CERTIFICATE:-}" ] && [ -z "${APPLE_CERTIFICATE_PASSWORD:-}" ]; then
  echo "APPLE_CERTIFICATE_PASSWORD is required when APPLE_CERTIFICATE is provided." >&2
  exit 1
fi

if [ -n "${APPLE_API_KEY:-}" ] \
  && [ -n "${APPLE_API_ISSUER:-}" ] \
  && [ -n "${APPLE_API_KEY_PATH:-}" ]; then
  if [ ! -r "${APPLE_API_KEY_PATH}" ]; then
    echo "APPLE_API_KEY_PATH does not point to a readable file." >&2
    exit 1
  fi
elif [ -n "${APPLE_ID:-}" ] \
  && [ -n "${APPLE_PASSWORD:-}" ] \
  && [ -n "${APPLE_TEAM_ID:-}" ]; then
  :
else
  echo "Official build requires either App Store Connect API credentials or Apple ID notarization credentials." >&2
  exit 1
fi

unset TAURI_SIGNING_PRIVATE_KEY
unset TAURI_SIGNING_PRIVATE_KEY_PATH
unset TAURI_SIGNING_PRIVATE_KEY_PASSWORD

cd "$PROJECT_ROOT"
# create-dmg checks the CI environment separately from Tauri's --ci flag.
# Keep official packaging headless and identical locally and on GitHub instead
# of relying on flaky Finder AppleScript automation.
CI=true "$TAURI_CLI" build \
  --ci \
  --bundles app,dmg \
  --config src-tauri/tauri.official.conf.json \
  --target universal-apple-darwin \
  --features official-distribution \
  -- \
  --locked

VERSION="$(node "$PROJECT_ROOT/scripts/release-preflight.mjs" --print-version)"
DMG_PATH="$PROJECT_ROOT/src-tauri/target/universal-apple-darwin/release/bundle/dmg/Macnu_${VERSION}_universal.dmg"
NOTARY_RESULT="$(mktemp)"
cleanup_notary_result() {
  rm -f "$NOTARY_RESULT"
}
trap cleanup_notary_result EXIT HUP INT TERM

if [ ! -f "$DMG_PATH" ]; then
  echo "Official DMG not found at $DMG_PATH." >&2
  exit 1
fi

echo "Submitting the finished Macnu DMG to Apple for notarization..."
if [ -n "${APPLE_API_KEY:-}" ] \
  && [ -n "${APPLE_API_ISSUER:-}" ] \
  && [ -n "${APPLE_API_KEY_PATH:-}" ]; then
  /usr/bin/xcrun notarytool submit "$DMG_PATH" \
    --key "$APPLE_API_KEY_PATH" \
    --key-id "$APPLE_API_KEY" \
    --issuer "$APPLE_API_ISSUER" \
    --wait \
    --output-format json > "$NOTARY_RESULT"
else
  /usr/bin/xcrun notarytool submit "$DMG_PATH" \
    --apple-id "$APPLE_ID" \
    --password "$APPLE_PASSWORD" \
    --team-id "$APPLE_TEAM_ID" \
    --wait \
    --output-format json > "$NOTARY_RESULT"
fi

NOTARY_STATUS="$(/usr/bin/plutil -extract status raw -o - "$NOTARY_RESULT")"
if [ "$NOTARY_STATUS" != "Accepted" ]; then
  echo "Apple did not accept the Macnu DMG for notarization:" >&2
  cat "$NOTARY_RESULT" >&2
  exit 1
fi
cat "$NOTARY_RESULT"

echo "Stapling the Apple notarization ticket to the Macnu DMG..."
/usr/bin/xcrun stapler staple "$DMG_PATH"
/usr/bin/xcrun stapler validate "$DMG_PATH"

trap - EXIT HUP INT TERM
cleanup_notary_result

"$PROJECT_ROOT/scripts/create-updater-archive.sh"
"$PROJECT_ROOT/scripts/verify-official.sh" --unsigned-updater
