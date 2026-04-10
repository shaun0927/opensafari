import {
  disableBackgroundServices,
  SERVICES_TO_DISABLE,
} from '../../src/simulator/post-boot-optimize';

const DEVICE = 'TEST-DEVICE-UDID';

describe('disableBackgroundServices', () => {
  test('calls simctl spawn for each service', async () => {
    const execMock = jest.fn().mockResolvedValue('');
    const simctl = { exec: execMock } as any;

    const disabled = await disableBackgroundServices(simctl, DEVICE);

    expect(disabled).toHaveLength(SERVICES_TO_DISABLE.length);
    // Each service gets a disable + stop call = 2 calls per service
    expect(execMock).toHaveBeenCalledTimes(SERVICES_TO_DISABLE.length * 2);

    // Verify first service gets correct args
    expect(execMock).toHaveBeenCalledWith(
      ['spawn', DEVICE, 'launchctl', 'disable', `system/${SERVICES_TO_DISABLE[0]}`],
      { timeout: 5000 },
    );
    expect(execMock).toHaveBeenCalledWith(
      ['spawn', DEVICE, 'launchctl', 'stop', SERVICES_TO_DISABLE[0]],
      { timeout: 5000 },
    );
  });

  test('skips services that fail to disable without throwing', async () => {
    const execMock = jest.fn()
      .mockRejectedValueOnce(new Error('not found'))  // disable fails for first service
      .mockResolvedValue('');  // all others succeed
    const simctl = { exec: execMock } as any;

    const disabled = await disableBackgroundServices(simctl, DEVICE);

    // First service failed to disable, so it's not in the list
    expect(disabled).toHaveLength(SERVICES_TO_DISABLE.length - 1);
    expect(disabled).not.toContain(SERVICES_TO_DISABLE[0]);
  });

  test('handles stop failure gracefully after successful disable', async () => {
    const execMock = jest.fn()
      .mockResolvedValueOnce('')   // disable succeeds
      .mockRejectedValueOnce(new Error('not running'))  // stop fails (service not running)
      .mockResolvedValue('');  // rest succeed
    const simctl = { exec: execMock } as any;

    const disabled = await disableBackgroundServices(simctl, DEVICE);

    // First service was still disabled successfully even though stop failed
    expect(disabled).toContain(SERVICES_TO_DISABLE[0]);
    expect(disabled).toHaveLength(SERVICES_TO_DISABLE.length);
  });

  test('returns empty array when all services fail', async () => {
    const execMock = jest.fn().mockRejectedValue(new Error('all fail'));
    const simctl = { exec: execMock } as any;

    const disabled = await disableBackgroundServices(simctl, DEVICE);

    expect(disabled).toHaveLength(0);
  });

  test('SERVICES_TO_DISABLE contains expected services', () => {
    expect(SERVICES_TO_DISABLE).toContain('com.apple.Spotlight');
    expect(SERVICES_TO_DISABLE).toContain('com.apple.analyticsd');
    expect(SERVICES_TO_DISABLE).toContain('com.apple.routined');
    expect(SERVICES_TO_DISABLE.length).toBeGreaterThanOrEqual(5);
  });
});
