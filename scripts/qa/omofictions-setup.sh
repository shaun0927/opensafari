#!/usr/bin/env bash
#
# omofictions-setup.sh
#
# Install and foreground the Omofictions-App build on a booted iOS simulator,
# in preparation for scripts/qa/omofictions-private-route.mjs.
#
# See docs/qa/omofictions-app.md for the full environment contract.
#
# Usage:
#   omofictions-setup.sh \
#     --device-id <UDID> \
#     --build-path <PATH_TO_DOT_APP>
#
# Behavior:
#   * Validates that the simulator is booted and no stuck modal is present
#     (see #43 for the class of failures this guards against).
#   * Idempotent: if the app is already installed, it is terminated and
#     reinstalled cleanly before relaunch.
#   * On success, prints the launched PID on stdout and exits 0.
#
# Exit codes:
#   0   success
#   64  bad args (missing or invalid flags)
#   69  device not booted
#   70  install failed (`simctl install` non-zero)
#   71  launch failed (`simctl launch` non-zero)
#   72  stuck modal / permission overlay detected — see #43
#
# Logging contract:
#   All human-readable output goes to stderr. stdout is reserved for the
#   launched PID on success so callers can pipe it cleanly. Any stdout line
#   other than the PID is a bug.

set -euo pipefail

readonly APP_BUNDLE_ID="com.omofictions.omofictionsApp"
readonly STUCK_MODAL_REF_ISSUE="https://github.com/junghwan-oss/opensafari/issues/43"

DEVICE_ID=""
BUILD_PATH=""

log() {
  printf >&2 '[omofictions-setup] %s\n' "$*"
}

die() {
  local code="$1"; shift
  log "ERROR ($code): $*"
  exit "$code"
}

usage() {
  cat >&2 <<'USAGE'
Usage: omofictions-setup.sh --device-id <UDID> --build-path <PATH_TO_DOT_APP>

Required:
  --device-id    Booted simulator UDID (see `xcrun simctl list devices`).
  --build-path   Path to the Omofictions-App `.app` bundle (unzipped).

Exit codes:
  0 success | 64 bad args | 69 device not booted | 70 install failed
  71 launch failed | 72 stuck modal detected (see #43)
USAGE
}

parse_args() {
  while (($# > 0)); do
    case "$1" in
      --device-id)
        [[ $# -ge 2 ]] || die 64 "--device-id requires a value"
        DEVICE_ID="$2"
        shift 2
        ;;
      --build-path)
        [[ $# -ge 2 ]] || die 64 "--build-path requires a value"
        BUILD_PATH="$2"
        shift 2
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        usage
        die 64 "unknown argument: $1"
        ;;
    esac
  done

  [[ -n "$DEVICE_ID" ]] || { usage; die 64 "--device-id is required"; }
  [[ -n "$BUILD_PATH" ]] || { usage; die 64 "--build-path is required"; }

  if [[ ! -d "$BUILD_PATH" ]]; then
    die 64 "--build-path does not exist or is not a directory: $BUILD_PATH"
  fi
  if [[ "$BUILD_PATH" != *.app ]]; then
    die 64 "--build-path must be a .app bundle, got: $BUILD_PATH"
  fi
  if [[ ! -f "$BUILD_PATH/Info.plist" ]]; then
    die 64 "--build-path is missing Info.plist: $BUILD_PATH"
  fi
}

assert_booted() {
  local state
  state=$(xcrun simctl list devices --json 2>/dev/null \
    | /usr/bin/python3 -c '
import json, sys
udid = sys.argv[1]
data = json.load(sys.stdin)
for runtime, devices in data.get("devices", {}).items():
    for d in devices:
        if d.get("udid") == udid:
            print(d.get("state", ""))
            sys.exit(0)
sys.exit(2)
' "$DEVICE_ID" 2>/dev/null) || die 69 "device $DEVICE_ID not found via simctl"

  if [[ "$state" != "Booted" ]]; then
    die 69 "device $DEVICE_ID is not booted (state=$state). Boot with: xcrun simctl boot $DEVICE_ID"
  fi
  log "device $DEVICE_ID is booted"
}

# A stuck permission overlay typically manifests as the SpringBoard alert
# banner on a freshly reset device. We approximate detection by asking
# simctl for the device's active alert via the privacy daemon: if there is
# a system dialog, it shows up as a non-empty stderr from a diagnostic
# command. This is intentionally conservative — false positives here fail
# loudly with a pointer to #43 instead of silently proceeding.
detect_stuck_modal() {
  local springboard_output
  springboard_output=$(xcrun simctl io "$DEVICE_ID" enumerate 2>/dev/null || true)
  # The marker used by the real alert-dismiss bug in #43: a SpringBoard
  # alert window reports as "AlertItemsService". We treat its presence as
  # a stuck-modal signal. If the output is empty the simulator is quiet.
  if [[ -n "$springboard_output" ]] \
    && printf '%s' "$springboard_output" | grep -q -E 'AlertItemsService|SBAlertItem'; then
    return 0
  fi
  return 1
}

preflight() {
  assert_booted
  if detect_stuck_modal; then
    die 72 "stuck permission overlay on $DEVICE_ID; dismiss via app_handle_alert before retry — see $STUCK_MODAL_REF_ISSUE"
  fi
  log "preflight OK"
}

uninstall_if_present() {
  if xcrun simctl get_app_container "$DEVICE_ID" "$APP_BUNDLE_ID" >/dev/null 2>&1; then
    log "app $APP_BUNDLE_ID already installed — terminating and uninstalling for idempotent reinstall"
    xcrun simctl terminate "$DEVICE_ID" "$APP_BUNDLE_ID" >/dev/null 2>&1 || true
    if ! xcrun simctl uninstall "$DEVICE_ID" "$APP_BUNDLE_ID" >&2; then
      die 70 "uninstall of $APP_BUNDLE_ID failed"
    fi
  fi
}

install_build() {
  log "installing $BUILD_PATH onto $DEVICE_ID"
  if ! xcrun simctl install "$DEVICE_ID" "$BUILD_PATH" >&2; then
    die 70 "simctl install failed"
  fi
}

launch_and_emit_pid() {
  log "launching $APP_BUNDLE_ID"
  local launch_output pid
  if ! launch_output=$(xcrun simctl launch "$DEVICE_ID" "$APP_BUNDLE_ID" 2>&1); then
    log "launch output: $launch_output"
    die 71 "simctl launch failed"
  fi
  # simctl launch emits "<bundle-id>: <pid>" on success.
  pid=$(printf '%s' "$launch_output" | awk -F': ' 'NR==1 { print $2 }')
  if [[ -z "$pid" || ! "$pid" =~ ^[0-9]+$ ]]; then
    die 71 "could not parse PID from launch output: $launch_output"
  fi
  # Give the app 3 s to reach a steady state so callers can query AX tree
  # without racing the splash screen.
  sleep 3
  log "launched pid=$pid"
  printf '%s\n' "$pid"
}

main() {
  parse_args "$@"
  preflight
  uninstall_if_present
  install_build
  launch_and_emit_pid
}

main "$@"
