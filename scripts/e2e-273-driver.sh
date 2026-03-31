#!/bin/bash
# E2E #273 Driver — controls simulator lifecycle, runs Node phases
set -e
UDID="D7D26213-C3E9-4623-BCCB-984CDF5D0793"
PORT=9522
DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"

log() { echo "[driver] $1" >&2; }
start_proxy() {
  pkill -9 -f ios_webkit_debug_proxy 2>/dev/null || true
  sleep 1
  SOCK=$(ls -t /private/var/tmp/com.apple.launchd.*/com.apple.webinspectord_sim.socket 2>/dev/null | head -1)
  if [ -z "$SOCK" ]; then log "ERROR: No socket"; exit 1; fi
  ios_webkit_debug_proxy -s "unix:$SOCK" -c "null:$((PORT-1)),:${PORT}-$((PORT+100))" -F &
  PROXY_PID=$!
  log "Proxy started (pid=$PROXY_PID)"
  for i in $(seq 1 20); do
    if curl -sf "http://localhost:$PORT/json" >/dev/null 2>&1; then log "Proxy ready"; return 0; fi
    sleep 1
  done
  log "WARNING: Proxy started but no targets"
}
stop_proxy() { kill -9 $PROXY_PID 2>/dev/null || true; }

# Ensure sim booted
log "Checking simulator..."
if ! xcrun simctl list devices | grep "$UDID" | grep -q Booted; then
  log "Booting simulator..."
  xcrun simctl boot "$UDID" 2>/dev/null || true
  sleep 8
fi
xcrun simctl openurl "$UDID" "https://example.com" 2>/dev/null || true
sleep 5

# === PHASE 1: Save profile ===
log "=== PHASE 1: Save auth profile ==="
start_proxy
P1=$(TEST_PORT=$PORT node scripts/e2e-273-phase1-save.cjs 2>&1)
P1_EXIT=$?
echo "$P1" >&2
if [ $P1_EXIT -ne 0 ]; then log "PHASE 1 FAILED"; stop_proxy; exit 1; fi
log "Phase 1 complete"

# === SHUTDOWN + REBOOT ===
stop_proxy
log "Shutting down simulator..."
xcrun simctl shutdown "$UDID" 2>/dev/null || true
for i in $(seq 1 30); do
  if xcrun simctl list devices | grep "$UDID" | grep -q Shutdown; then break; fi
  sleep 2
done
log "Simulator shut down"

log "Rebooting simulator..."
xcrun simctl boot "$UDID"
sleep 12
for i in $(seq 1 5); do
  xcrun simctl openurl "$UDID" "https://example.com" 2>/dev/null && break
  sleep 3
done
sleep 5

# === PHASE 2: Restore after reboot ===
log "=== PHASE 2: Restore and verify ==="
start_proxy
P2=$(TEST_PORT=$PORT node scripts/e2e-273-phase2-restore.cjs 2>&1)
P2_EXIT=$?
echo "$P2" >&2
if [ $P2_EXIT -ne 0 ]; then
  log "❌ TEST 1 FAILED: Auth profile did NOT survive reboot"
  stop_proxy; exit 1
else
  log "✅ TEST 1 PASSED: Auth profile survives shutdown/reboot"
fi

# === PHASE 3: Multi-profile, expiry, cross-device, permissions ===
log "=== PHASE 3: Remaining tests ==="
P3=$(TEST_PORT=$PORT node scripts/e2e-273-phase3-multi-expire-perm.cjs 2>&1)
P3_EXIT=$?
echo "$P3" >&2
stop_proxy

if [ $P3_EXIT -ne 0 ]; then
  log "❌ SOME TESTS FAILED"
  exit 1
else
  log "✅ ALL 5 TESTS PASSED"
fi
