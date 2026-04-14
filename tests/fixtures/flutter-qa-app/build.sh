#!/bin/sh
set -euo pipefail

# Build script for flutter-qa-app fixture.
# Usage: ./build.sh [--mode debug|release] [--device-id <udid>] [--install]
#
# Note: iOS Simulator only supports --debug mode for "flutter build ios --simulator".
# When --mode release is specified, the script builds with --simulator --debug, which
# is the only valid mode for simulator targets and still exercises the semantics tree
# path that opensafari's activator needs to handle.

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

# Resolve device ID: pick first booted simulator if not provided.
if [ -z "$DEVICE_ID" ]; then
  DEVICE_ID="$(xcrun simctl list devices booted | grep -oE '[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}' | head -1)"
  if [ -z "$DEVICE_ID" ]; then
    echo "Error: no booted simulator found and --device-id not specified" >&2
    exit 1
  fi
fi

cd "$SCRIPT_DIR"

echo "Running flutter pub get..."
flutter pub get

# iOS Simulator only supports --debug with --simulator flag.
# Both debug and release modes use --debug here; the distinction matters for physical device builds.
echo "Building flutter_qa_app (--mode $MODE) for simulator..."
flutter build ios --simulator --debug

# Derive .app path.
# Flutter debug simulator builds output to Debug-iphonesimulator/; there is no release
# simulator path since --release is not supported for --simulator targets.
APP_PATH="$SCRIPT_DIR/build/ios/Debug-iphonesimulator/Runner.app"

if [ ! -d "$APP_PATH" ]; then
  echo "Error: expected .app not found at $APP_PATH" >&2
  exit 1
fi

BUNDLE_ID="com.opensafari.fixtures.flutterQaApp"

if [ "$INSTALL" -eq 1 ]; then
  echo "Installing $APP_PATH on simulator $DEVICE_ID..."
  xcrun simctl install "$DEVICE_ID" "$APP_PATH"
  echo "Install complete."
fi

echo "BUNDLE_ID=$BUNDLE_ID"
echo "APP_PATH=$APP_PATH"
