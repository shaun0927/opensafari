#!/bin/sh
set -euo pipefail

# Build script for flutter_spinner fixture (GitHub issue #46).
# Usage: ./build.sh [--mode debug|release] [--device-id <udid>] [--install]
#
# iOS Simulator only supports --debug builds; --mode release is accepted for
# parity with the flutter-qa-app fixture but still produces a debug-simulator
# build, which is the only mode that exercises the AX semantics path.
#
# First-time setup (if tests/fixtures/flutter_spinner/ios does not exist):
#   (cd tests/fixtures/flutter_spinner && \
#      flutter create --platforms=ios --org com.opensafari.fixtures \
#                     --project-name flutter_spinner_qa .)
# Then edit ios/Runner.xcodeproj/project.pbxproj (or use `xcrun agvtool`) to
# set PRODUCT_BUNDLE_IDENTIFIER = com.opensafari.fixtures.flutterSpinnerQa.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MODE="release"
DEVICE_ID=""
INSTALL=0

while [ $# -gt 0 ]; do
  case "$1" in
    --mode)
      MODE="$2"
      shift 2
      ;;
    --device-id)
      DEVICE_ID="$2"
      shift 2
      ;;
    --install)
      INSTALL=1
      shift
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

if [ "$MODE" != "debug" ] && [ "$MODE" != "release" ]; then
  echo "Error: --mode must be 'debug' or 'release'" >&2
  exit 1
fi

if [ -z "$DEVICE_ID" ]; then
  DEVICE_ID="$(xcrun simctl list devices booted | grep -oE '[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}' | head -1)"
  if [ -z "$DEVICE_ID" ]; then
    echo "Error: no booted simulator found and --device-id not specified" >&2
    exit 1
  fi
fi

cd "$SCRIPT_DIR"

if [ ! -d "ios" ]; then
  echo "Error: ios/ scaffold missing. Run:" >&2
  echo "  flutter create --platforms=ios --org com.opensafari.fixtures --project-name flutter_spinner_qa ." >&2
  echo "then set PRODUCT_BUNDLE_IDENTIFIER = com.opensafari.fixtures.flutterSpinnerQa in Xcode." >&2
  exit 1
fi

echo "Running flutter pub get..."
flutter pub get

echo "Building flutter_spinner_qa (--mode $MODE) for simulator..."
flutter build ios --simulator --debug

APP_PATH="$SCRIPT_DIR/build/ios/Debug-iphonesimulator/Runner.app"

if [ ! -d "$APP_PATH" ]; then
  echo "Error: expected .app not found at $APP_PATH" >&2
  exit 1
fi

BUNDLE_ID="com.opensafari.fixtures.flutterSpinnerQa"

if [ "$INSTALL" -eq 1 ]; then
  echo "Installing $APP_PATH on simulator $DEVICE_ID..."
  xcrun simctl install "$DEVICE_ID" "$APP_PATH"
  echo "Install complete."
fi

echo "BUNDLE_ID=$BUNDLE_ID"
