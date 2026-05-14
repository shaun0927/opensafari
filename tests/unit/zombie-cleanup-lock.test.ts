import { sleepWithoutBusySpin } from '../../src/reliability/zombie-cleanup';

describe('zombie cleanup registry lock wait helper', () => {
  it('returns immediately for non-positive durations', () => {
    const start = Date.now();
    sleepWithoutBusySpin(0);
    sleepWithoutBusySpin(-10);
    expect(Date.now() - start).toBeLessThan(25);
  });

  it('waits for approximately the requested duration without a JavaScript spin loop', () => {
    const start = Date.now();
    sleepWithoutBusySpin(15);
    expect(Date.now() - start).toBeGreaterThanOrEqual(10);
  });
});
