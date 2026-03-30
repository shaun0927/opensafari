import { CircuitBreaker, CircuitBreakerRegistry } from '../../src/reliability/circuit-breaker';
import type { StateChangeEvent } from '../../src/reliability/circuit-breaker';

describe('CircuitBreaker', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  it('starts in closed state', () => {
    const cb = new CircuitBreaker('device-1');
    expect(cb.getState()).toBe('closed');
    expect(cb.getFailureCount()).toBe(0);
    expect(cb.getDeviceId()).toBe('device-1');
  });

  it('stays closed on success', () => {
    const cb = new CircuitBreaker('device-1');
    cb.recordSuccess();
    expect(cb.getState()).toBe('closed');
  });

  it('stays closed below failure threshold', () => {
    const cb = new CircuitBreaker('device-1', { failureThreshold: 3 });
    cb.recordFailure(new Error('fail 1'));
    cb.recordFailure(new Error('fail 2'));
    expect(cb.getState()).toBe('closed');
    expect(cb.getFailureCount()).toBe(2);
    expect(cb.isAvailable()).toBe(true);
  });

  it('opens after reaching failure threshold', () => {
    const cb = new CircuitBreaker('device-1', { failureThreshold: 3 });
    const changes: StateChangeEvent[] = [];
    cb.on('state-change', (e: StateChangeEvent) => changes.push(e));
    cb.recordFailure(new Error('1'));
    cb.recordFailure(new Error('2'));
    cb.recordFailure(new Error('3'));
    expect(cb.getState()).toBe('open');
    expect(cb.isAvailable()).toBe(false);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ from: 'closed', to: 'open' });
  });

  it('transitions to half-open after cooldown', () => {
    const cb = new CircuitBreaker('device-1', { failureThreshold: 1, cooldownMs: 5000 });
    const changes: StateChangeEvent[] = [];
    cb.on('state-change', (e: StateChangeEvent) => changes.push(e));
    cb.recordFailure();
    expect(cb.getState()).toBe('open');
    expect(cb.isAvailable()).toBe(false);
    jest.advanceTimersByTime(5000);
    expect(cb.isAvailable()).toBe(true);
    expect(cb.getState()).toBe('half-open');
    expect(changes).toHaveLength(2);
    expect(changes[1]).toMatchObject({ from: 'open', to: 'half-open' });
  });

  it('returns to closed on success in half-open', () => {
    const cb = new CircuitBreaker('device-1', { failureThreshold: 1, cooldownMs: 1000 });
    cb.recordFailure();
    jest.advanceTimersByTime(1000);
    cb.isAvailable();
    cb.recordSuccess();
    expect(cb.getState()).toBe('closed');
    expect(cb.getFailureCount()).toBe(0);
  });

  it('re-opens on failure in half-open', () => {
    const cb = new CircuitBreaker('device-1', { failureThreshold: 1, cooldownMs: 1000 });
    const changes: StateChangeEvent[] = [];
    cb.on('state-change', (e: StateChangeEvent) => changes.push(e));
    cb.recordFailure();
    jest.advanceTimersByTime(1000);
    cb.isAvailable();
    cb.recordFailure(new Error('still broken'));
    expect(cb.getState()).toBe('open');
    expect(changes[changes.length - 1]).toMatchObject({ from: 'half-open', to: 'open' });
  });

  it('limits half-open attempts', () => {
    const cb = new CircuitBreaker('device-1', { failureThreshold: 1, cooldownMs: 1000, halfOpenMaxAttempts: 1 });
    cb.recordFailure();
    jest.advanceTimersByTime(1000);
    expect(cb.isAvailable()).toBe(true);
    expect(cb.isAvailable()).toBe(false);
  });

  it('reset() returns to closed from any state', () => {
    const cb = new CircuitBreaker('device-1', { failureThreshold: 1 });
    const changes: StateChangeEvent[] = [];
    cb.on('state-change', (e: StateChangeEvent) => changes.push(e));
    cb.recordFailure();
    cb.reset();
    expect(cb.getState()).toBe('closed');
    expect(cb.getFailureCount()).toBe(0);
    expect(cb.isAvailable()).toBe(true);
    expect(changes[changes.length - 1]).toMatchObject({ from: 'open', to: 'closed' });
  });

  it('reset() on closed state does not emit', () => {
    const cb = new CircuitBreaker('device-1');
    const listener = jest.fn();
    cb.on('state-change', listener);
    cb.reset();
    expect(listener).not.toHaveBeenCalled();
  });

  it('trip() force-opens circuit', () => {
    const cb = new CircuitBreaker('device-1');
    const changes: StateChangeEvent[] = [];
    cb.on('state-change', (e: StateChangeEvent) => changes.push(e));
    cb.trip();
    expect(cb.getState()).toBe('open');
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ from: 'closed', to: 'open' });
  });

  it('trip() on already open circuit does not emit', () => {
    const cb = new CircuitBreaker('device-1', { failureThreshold: 1 });
    cb.recordFailure();
    const listener = jest.fn();
    cb.on('state-change', listener);
    cb.trip();
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('CircuitBreakerRegistry', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  it('creates breakers on demand', () => {
    const r = new CircuitBreakerRegistry();
    const cb = r.get('d1');
    expect(cb).toBeInstanceOf(CircuitBreaker);
    expect(r.get('d1')).toBe(cb);
  });

  it('remove() deletes a breaker', () => {
    const r = new CircuitBreakerRegistry();
    const cb1 = r.get('d1');
    r.remove('d1');
    expect(r.get('d1')).not.toBe(cb1);
  });

  it('getAvailableDeviceIds() filters out open circuits', () => {
    const r = new CircuitBreakerRegistry({ failureThreshold: 1 });
    r.get('d1'); r.get('d2'); r.get('d3');
    r.get('d2').recordFailure();
    const avail = r.getAvailableDeviceIds();
    expect(avail).toContain('d1');
    expect(avail).not.toContain('d2');
    expect(avail).toContain('d3');
  });

  it('getAllStates() returns state map', () => {
    const r = new CircuitBreakerRegistry({ failureThreshold: 1 });
    r.get('d1'); r.get('d2').recordFailure();
    const s = r.getAllStates();
    expect(s.get('d1')).toBe('closed');
    expect(s.get('d2')).toBe('open');
  });

  it('resetAll() resets all breakers', () => {
    const r = new CircuitBreakerRegistry({ failureThreshold: 1 });
    r.get('d1').recordFailure(); r.get('d2').recordFailure();
    r.resetAll();
    expect(r.get('d1').getState()).toBe('closed');
    expect(r.get('d2').getState()).toBe('closed');
  });

  it('passes default options to new breakers', () => {
    const r = new CircuitBreakerRegistry({ failureThreshold: 2 });
    const cb = r.get('d1');
    cb.recordFailure();
    expect(cb.getState()).toBe('closed');
    cb.recordFailure();
    expect(cb.getState()).toBe('open');
  });
});
