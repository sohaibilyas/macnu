#!/bin/sh
set -eu

PROJECT_ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
EXPECTED_VERSION="$(node "$PROJECT_ROOT/scripts/release-preflight.mjs" --print-version)"
SELF_TEST=0
SIGNED_UPDATER=1
if [ "${1:-}" = "--self-test" ]; then
  SELF_TEST=1
  shift
fi
if [ "${1:-}" = "--unsigned-updater" ]; then
  SIGNED_UPDATER=0
  shift
fi
if [ "$#" -gt 1 ]; then
  echo "Usage: $0 [--self-test] [--unsigned-updater] [version]" >&2
  exit 1
fi
VERSION="${1:-$EXPECTED_VERSION}"
if [ "$VERSION" != "$EXPECTED_VERSION" ]; then
  echo "Requested version $VERSION does not match project version $EXPECTED_VERSION." >&2
  exit 1
fi

BUNDLE_ROOT="$PROJECT_ROOT/src-tauri/target/universal-apple-darwin/release/bundle"
APP_PATH="$BUNDLE_ROOT/macos/Macnu.app"
ARCHIVE_PATH="$BUNDLE_ROOT/macos/Macnu.app.tar.gz"
SIGNATURE_PATH="$ARCHIVE_PATH.sig"
DMG_PATH="$BUNDLE_ROOT/dmg/Macnu_${VERSION}_universal.dmg"
EXPECTED_BUNDLE_ID="com.qoest.macnu"
EXPECTED_TEAM_ID="UVYJU3MY6G"
EXPECTED_EXECUTABLE="macnu"

plist_value() {
  /usr/libexec/PlistBuddy -c "Print :$2" "$1/Contents/Info.plist"
}

assert_equal() {
  if [ "$2" != "$3" ]; then
    echo "$1: expected '$2', found '$3'." >&2
    exit 1
  fi
}

signature_field() {
  printf '%s\n' "$1" | sed -n "s/^$2=//p" | sed -n '1p'
}

runtime_flags() {
  printf '%s\n' "$1" |
    awk '
      /^CodeDirectory / && / flags=[^(]*\([^)]*\)/ {
        flags = $0
        sub(/^.* flags=[^(]*\(/, "", flags)
        sub(/\).*$/, "", flags)
        print flags
        exit
      }
    '
}

has_hardened_runtime() {
  FLAGS="$(runtime_flags "$1")"
  case ",$FLAGS," in
    *,runtime,*) return 0 ;;
    *) return 1 ;;
  esac
}

if [ "$SELF_TEST" = "1" ]; then
  VALID_SIGNATURE_DETAILS='Identifier=com.qoest.macnu
CodeDirectory v=20500 size=123 flags=0x10000(runtime) hashes=1+7 location=embedded
TeamIdentifier=UVYJU3MY6G
Timestamp=24 Aug 2026 at 00:00:00'
  MISLEADING_SIGNATURE_DETAILS='CodeDirectory v=20500 flags=0x0(notruntime) hashes=1+7 location=embedded'
  assert_equal "hardened-runtime parser" "runtime" "$(runtime_flags "$VALID_SIGNATURE_DETAILS")"
  has_hardened_runtime "$VALID_SIGNATURE_DETAILS"
  if has_hardened_runtime "$MISLEADING_SIGNATURE_DETAILS"; then
    echo "Hardened-runtime parser accepted a misleading flag." >&2
    exit 1
  fi
  echo "Official release shell verifier self-test passed."
  exit 0
fi

validate_app() {
  APP="$1"
  LABEL="$2"
  if [ ! -d "$APP" ]; then
    echo "$LABEL not found at $APP." >&2
    exit 1
  fi

  assert_equal "$LABEL bundle identifier" "$EXPECTED_BUNDLE_ID" "$(plist_value "$APP" CFBundleIdentifier)"
  assert_equal "$LABEL short version" "$VERSION" "$(plist_value "$APP" CFBundleShortVersionString)"
  assert_equal "$LABEL bundle version" "$VERSION" "$(plist_value "$APP" CFBundleVersion)"
  assert_equal "$LABEL executable" "$EXPECTED_EXECUTABLE" "$(plist_value "$APP" CFBundleExecutable)"
  assert_equal "$LABEL icon" "icon.icns" "$(plist_value "$APP" CFBundleIconFile)"
  assert_equal "$LABEL distribution" "official" "$(plist_value "$APP" MacnuDistribution)"
  assert_equal "$LABEL update channel" "stable" "$(plist_value "$APP" MacnuUpdateChannel)"

  if [ ! -f "$APP/Contents/Resources/icon.icns" ]; then
    echo "$LABEL has no packaged icon.icns resource." >&2
    exit 1
  fi

  EXECUTABLE_PATH="$APP/Contents/MacOS/$EXPECTED_EXECUTABLE"
  if [ ! -f "$EXECUTABLE_PATH" ] || [ ! -x "$EXECUTABLE_PATH" ]; then
    echo "$LABEL has no executable macnu binary." >&2
    exit 1
  fi

  SIGNATURE_DETAILS="$(/usr/bin/codesign -dv --verbose=4 "$APP" 2>&1)"
  if ! printf '%s\n' "$SIGNATURE_DETAILS" | grep -q '^Authority=Developer ID Application: '; then
    echo "$LABEL is not signed with a Developer ID Application certificate." >&2
    exit 1
  fi
  assert_equal "$LABEL Apple Team ID" "$EXPECTED_TEAM_ID" "$(signature_field "$SIGNATURE_DETAILS" TeamIdentifier)"
  assert_equal "$LABEL code-signing identifier" "$EXPECTED_BUNDLE_ID" "$(signature_field "$SIGNATURE_DETAILS" Identifier)"

  if ! has_hardened_runtime "$SIGNATURE_DETAILS"; then
    echo "$LABEL is missing hardened runtime." >&2
    exit 1
  fi
  if [ -z "$(signature_field "$SIGNATURE_DETAILS" Timestamp)" ]; then
    echo "$LABEL is missing a secure signing timestamp." >&2
    exit 1
  fi

  ARCHITECTURES="$(/usr/bin/lipo -archs "$EXECUTABLE_PATH")"
  set -- $ARCHITECTURES
  if [ "$#" -ne 2 ]; then
    echo "$LABEL does not contain exactly two architectures." >&2
    exit 1
  fi
  case " $ARCHITECTURES " in *" arm64 "*) ;; *) echo "$LABEL is missing arm64." >&2; exit 1 ;; esac
  case " $ARCHITECTURES " in *" x86_64 "*) ;; *) echo "$LABEL is missing x86_64." >&2; exit 1 ;; esac

  /usr/bin/codesign --verify --deep --strict --verbose=2 "$APP"
  /usr/bin/xcrun stapler validate "$APP"
  /usr/sbin/spctl --assess --type execute --verbose=4 "$APP"
}

for REQUIRED_FILE in "$ARCHIVE_PATH" "$DMG_PATH"; do
  if [ ! -f "$REQUIRED_FILE" ]; then
    echo "Required official artifact not found at $REQUIRED_FILE." >&2
    exit 1
  fi
done
if [ "$SIGNED_UPDATER" = "1" ] && [ ! -f "$SIGNATURE_PATH" ]; then
  echo "Required updater signature not found at $SIGNATURE_PATH." >&2
  exit 1
fi

validate_app "$APP_PATH" "Built application"

if [ "$SIGNED_UPDATER" = "1" ]; then
  cargo run \
    --quiet \
    --locked \
    --release \
    --manifest-path "$PROJECT_ROOT/tools/release-verifier/Cargo.toml" \
    -- \
    "$ARCHIVE_PATH" \
    "$SIGNATURE_PATH" \
    "$VERSION"
else
  cargo run \
    --quiet \
    --locked \
    --release \
    --manifest-path "$PROJECT_ROOT/tools/release-verifier/Cargo.toml" \
    -- \
    --archive-only \
    "$ARCHIVE_PATH" \
    "$VERSION"
fi

/usr/bin/hdiutil verify "$DMG_PATH"
/usr/bin/codesign --verify --strict --verbose=2 "$DMG_PATH"
DMG_SIGNATURE_DETAILS="$(/usr/bin/codesign -dv --verbose=4 "$DMG_PATH" 2>&1)"
if ! printf '%s\n' "$DMG_SIGNATURE_DETAILS" | grep -q '^Authority=Developer ID Application: '; then
  echo "The DMG is not Developer ID signed." >&2
  exit 1
fi
assert_equal "DMG Apple Team ID" "$EXPECTED_TEAM_ID" "$(signature_field "$DMG_SIGNATURE_DETAILS" TeamIdentifier)"
if [ -z "$(signature_field "$DMG_SIGNATURE_DETAILS" Timestamp)" ]; then
  echo "The DMG is missing a secure signing timestamp." >&2
  exit 1
fi
/usr/bin/xcrun stapler validate "$DMG_PATH"
/usr/sbin/spctl --assess --type open --context context:primary-signature --verbose=4 "$DMG_PATH"

VERIFY_ROOT="$(mktemp -d)"
MOUNT_PATH="$VERIFY_ROOT/dmg"
ATTACHED=0
cleanup() {
  if [ "$ATTACHED" = "1" ]; then
    /usr/bin/hdiutil detach "$MOUNT_PATH" -quiet >/dev/null 2>&1 || \
      /usr/bin/hdiutil detach "$MOUNT_PATH" -force -quiet >/dev/null 2>&1 || true
  fi
  rm -rf "$VERIFY_ROOT"
}
trap cleanup EXIT HUP INT TERM
mkdir "$MOUNT_PATH"
/usr/bin/hdiutil attach -readonly -nobrowse -mountpoint "$MOUNT_PATH" "$DMG_PATH" >/dev/null
ATTACHED=1
validate_app "$MOUNT_PATH/Macnu.app" "DMG application"
/usr/bin/hdiutil detach "$MOUNT_PATH" -quiet
ATTACHED=0
trap - EXIT HUP INT TERM
rm -rf "$VERIFY_ROOT"

if [ "$SIGNED_UPDATER" = "1" ]; then
  echo "Verified official Macnu app, signed updater archive, and DMG for v$VERSION."
else
  echo "Verified official Macnu app, unsigned updater archive, and DMG for v$VERSION."
fi
