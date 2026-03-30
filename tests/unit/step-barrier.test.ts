import { StepBarrier } from '../../src/orchestration/step-barrier';

describe('StepBarrier', () => {
  let barrier: StepBarrier;

  beforeEach(() => {
    barrier = new StepBarrier();
  });

  afterEach(() => {
    barrier.clearAll();
  });

  it('resolves both devices when the second arrives', async () => {
    const devices = ['deviceA', 'deviceB'];

    const [resultA, resultB] = await Promise.all([
      barrier.wait('step1', 'deviceA', devices),
      barrier.wait('step1', 'deviceB', devices),
    ]);

    expect(resultA.allArrived).toBe(true);
    expect(resultA.stepName).toBe('step1');
    expect(resultA.arrivedDevices).toEqual(expect.arrayContaining(['deviceA', 'deviceB']));
    expect(resultA.missingDevices).toEqual([]);

    expect(resultB.allArrived).toBe(true);
    expect(resultB.arrivedDevices).toEqual(expect.arrayContaining(['deviceA', 'deviceB']));
    expect(resultB.missingDevices).toEqual([]);
  });

  it('times out when a device never arrives', async () => {
    const devices = ['deviceA', 'deviceB'];

    const result = await barrier.wait('step-timeout', 'deviceA', devices, { timeout: 100 });

    expect(result.allArrived).toBe(false);
    expect(result.arrivedDevices).toContain('deviceA');
    expect(result.missingDevices).toContain('deviceB');
    expect(result.waitTime).toBeGreaterThanOrEqual(90);
  });

  it('includes correct waitTime and device lists', async () => {
    const devices = ['d1', 'd2', 'd3'];

    // d1 and d2 arrive, d3 never does -- timeout
    const [r1, r2] = await Promise.all([
      barrier.wait('step-partial', 'd1', devices, { timeout: 100 }),
      barrier.wait('step-partial', 'd2', devices, { timeout: 100 }),
    ]);

    expect(r1.allArrived).toBe(false);
    expect(r1.missingDevices).toContain('d3');
    expect(r1.arrivedDevices).toEqual(expect.arrayContaining(['d1', 'd2']));
    expect(r1.waitTime).toBeGreaterThanOrEqual(90);

    expect(r2.allArrived).toBe(false);
    expect(r2.missingDevices).toContain('d3');
  });

  it('getStatus returns correct counts', async () => {
    const devices = ['devA', 'devB', 'devC'];

    // Start a wait that will not complete (only 1 of 3 arrives).
    const promise = barrier.wait('status-step', 'devA', devices, { timeout: 200 });

    // Allow microtask to register.
    await new Promise((r) => setTimeout(r, 10));

    const status = barrier.getStatus('status-step');
    expect(status).not.toBeNull();
    expect(status!.expectedCount).toBe(3);
    expect(status!.arrivedCount).toBe(1);
    expect(status!.arrivedDevices).toEqual(['devA']);
    expect(status!.missingDevices).toEqual(expect.arrayContaining(['devB', 'devC']));

    // Let timeout fire so the promise resolves and timers are cleaned.
    await promise;
  });

  it('getStatus returns null for unknown step', () => {
    expect(barrier.getStatus('nonexistent')).toBeNull();
  });

  it('clear() removes a barrier', async () => {
    const devices = ['a', 'b'];

    // Start a wait that will not complete (only 1 of 2 arrives).
    const promise = barrier.wait('clear-step', 'a', devices, { timeout: 5000 });

    // Allow microtask to register.
    await new Promise((r) => setTimeout(r, 10));

    expect(barrier.getStatus('clear-step')).not.toBeNull();

    barrier.clear('clear-step');
    expect(barrier.getStatus('clear-step')).toBeNull();

    // The promise is still pending but the barrier is gone.
    // We cannot await it (it will never resolve since the barrier was cleared).
    // Just verify the barrier was removed.
    void promise;
  });

  it('clearAll() removes all barriers', async () => {
    const devices = ['x', 'y'];

    // Start two independent barriers.
    const p1 = barrier.wait('all-1', 'x', devices, { timeout: 5000 });
    const p2 = barrier.wait('all-2', 'x', devices, { timeout: 5000 });

    await new Promise((r) => setTimeout(r, 10));

    expect(barrier.getStatus('all-1')).not.toBeNull();
    expect(barrier.getStatus('all-2')).not.toBeNull();

    barrier.clearAll();

    expect(barrier.getStatus('all-1')).toBeNull();
    expect(barrier.getStatus('all-2')).toBeNull();

    void p1;
    void p2;
  });

  it('multiple independent barriers can exist simultaneously', async () => {
    const devicesAB = ['a', 'b'];
    const devicesXY = ['x', 'y'];

    const [rA, rB, rX, rY] = await Promise.all([
      barrier.wait('barrier-1', 'a', devicesAB),
      barrier.wait('barrier-1', 'b', devicesAB),
      barrier.wait('barrier-2', 'x', devicesXY),
      barrier.wait('barrier-2', 'y', devicesXY),
    ]);

    expect(rA.allArrived).toBe(true);
    expect(rA.stepName).toBe('barrier-1');
    expect(rB.allArrived).toBe(true);

    expect(rX.allArrived).toBe(true);
    expect(rX.stepName).toBe('barrier-2');
    expect(rY.allArrived).toBe(true);
  });

  it('returns immediately if a device calls wait() again after arriving', async () => {
    const devices = ['a', 'b'];

    // Both arrive.
    await Promise.all([
      barrier.wait('dup-step', 'a', devices),
      barrier.wait('dup-step', 'b', devices),
    ]);

    // Device A calls wait again -- should resolve immediately.
    const result = await barrier.wait('dup-step', 'a', devices);
    expect(result.allArrived).toBe(true);
  });

  it('handles three devices correctly', async () => {
    const devices = ['d1', 'd2', 'd3'];

    const [r1, r2, r3] = await Promise.all([
      barrier.wait('three-way', 'd1', devices),
      barrier.wait('three-way', 'd2', devices),
      barrier.wait('three-way', 'd3', devices),
    ]);

    expect(r1.allArrived).toBe(true);
    expect(r2.allArrived).toBe(true);
    expect(r3.allArrived).toBe(true);
    expect(r1.arrivedDevices.length).toBe(3);
  });
});
