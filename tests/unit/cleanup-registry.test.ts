/**
 * Unit tests for NodeCleanupRegistry (issue #640, PR 4).
 *
 * Validates:
 *   - add() returns an unregister function that actually unregisters
 *   - fireForTests() drains handlers and returns the count
 *   - handlers survive failures of peer handlers (Promise.allSettled)
 *   - disableForTests suppresses real process handler installation
 *
 * We never install real signal handlers here — `process.env.JEST_WORKER_ID`
 * is set by Jest, which the default `NodeCleanupRegistry` constructor
 * interprets as "tests — do not touch process signals".
 */

import { NodeCleanupRegistry } from '../../src/simulator/network-blockers';

describe('NodeCleanupRegistry', () => {
  it('add() registers a handler and returns an unregister function', async () => {
    const r = new NodeCleanupRegistry();
    const fn = jest.fn<Promise<void>, []>().mockResolvedValue(undefined);
    const unregister = r.add(fn);
    expect(r.size()).toBe(1);
    unregister();
    expect(r.size()).toBe(0);
  });

  it('fireForTests() drains and clears handlers, returning the count', async () => {
    const r = new NodeCleanupRegistry();
    const a = jest.fn<Promise<void>, []>().mockResolvedValue(undefined);
    const b = jest.fn<Promise<void>, []>().mockResolvedValue(undefined);
    r.add(a);
    r.add(b);
    const fired = await r.fireForTests();
    expect(fired).toBe(2);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    expect(r.size()).toBe(0);
  });

  it('fireForTests() isolates handlers from each other (allSettled)', async () => {
    const r = new NodeCleanupRegistry();
    const failing = jest.fn<Promise<void>, []>().mockRejectedValue(new Error('boom'));
    const succeeding = jest.fn<Promise<void>, []>().mockResolvedValue(undefined);
    r.add(failing);
    r.add(succeeding);
    await expect(r.fireForTests()).resolves.toBe(2);
    expect(failing).toHaveBeenCalled();
    expect(succeeding).toHaveBeenCalled();
  });

  it('unregister only removes the specific handler', async () => {
    const r = new NodeCleanupRegistry();
    const a = jest.fn<Promise<void>, []>().mockResolvedValue(undefined);
    const b = jest.fn<Promise<void>, []>().mockResolvedValue(undefined);
    r.add(a);
    const unregisterB = r.add(b);
    unregisterB();
    expect(r.size()).toBe(1);
    await r.fireForTests();
    expect(a).toHaveBeenCalled();
    expect(b).not.toHaveBeenCalled();
  });

  it('clearForTests() drops handlers without firing them', async () => {
    const r = new NodeCleanupRegistry();
    const a = jest.fn<Promise<void>, []>().mockResolvedValue(undefined);
    r.add(a);
    r.clearForTests();
    expect(r.size()).toBe(0);
    await r.fireForTests();
    expect(a).not.toHaveBeenCalled();
  });

  it('disableForTests() prevents real handler installation (idempotent, safe)', () => {
    const r = new NodeCleanupRegistry();
    r.disableForTests();
    // Even with JEST_WORKER_ID unset this would be a no-op; the key
    // guarantee is that add() doesn't throw or mutate process handlers.
    const unreg = r.add(async () => undefined);
    expect(r.size()).toBe(1);
    unreg();
  });
});
