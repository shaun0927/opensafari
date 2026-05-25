/**
 * Per-device circuit breakers for Flutter VM Service calls.
 *
 * Lives separately from `SimulatorPool`'s registry because the failure modes
 * are different: the pool's breaker trips on simulator-level memory/crash
 * signals (minute-scale recovery), whereas this one trips on a short burst
 * of VM Service request failures (e.g. ios-webkit-debug-proxy thrashing).
 *
 * Threshold tuned conservatively — 3 consecutive failures within the
 * cooldown window will fail-fast subsequent `callMethod` invocations for
 * 10 seconds so a flapping VM Service can't pin up the event loop with
 * repeated 10-30 s timeouts.
 */

import { CircuitBreakerRegistry } from '../reliability/circuit-breaker';

const registry = new CircuitBreakerRegistry({
  failureThreshold: 3,
  cooldownMs: 10_000,
  halfOpenMaxAttempts: 1,
});

export function flutterCircuitBreakers(): CircuitBreakerRegistry {
  return registry;
}
