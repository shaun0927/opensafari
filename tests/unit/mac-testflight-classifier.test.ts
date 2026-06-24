import { classifyMacTestFlight, flattenLabels } from '../../src/macos/testflight';
import type { HostAXNode } from '../../src/macos/host-ax';

const root = (...labels: string[]): HostAXNode => ({
  role: 'AXApplication', frame: { x: 0, y: 0, width: 800, height: 600 }, visible: true, enabled: true, focused: false, actions: [], path: '',
  children: labels.map((label, i) => ({ role: 'AXButton', label, frame: { x: i * 10, y: 0, width: 10, height: 10 }, visible: true, enabled: true, focused: false, actions: ['AXPress'], path: String(i) })),
});

describe('mac TestFlight classifier', () => {
  it('flattens AX labels', () => {
    expect(flattenLabels(root('Omofictions', 'Open'))).toEqual(expect.arrayContaining(['AXButton Omofictions', 'AXButton Open']));
  });

  it('reports missing host TestFlight', () => {
    expect(classifyMacTestFlight(root('Omofictions'), 'Omofictions', false)).toMatchObject({ state: 'HOST_TESTFLIGHT_MISSING', confidence: 'high' });
  });

  it('classifies app actions', () => {
    expect(classifyMacTestFlight(root('Omofictions', 'Install'), 'Omofictions', true)).toMatchObject({ state: 'INSTALL_AVAILABLE' });
    expect(classifyMacTestFlight(root('Omofictions', 'Update'), 'Omofictions', true)).toMatchObject({ state: 'UPDATE_AVAILABLE' });
    expect(classifyMacTestFlight(root('Omofictions', 'Open'), 'Omofictions', true)).toMatchObject({ state: 'OPEN_AVAILABLE' });
  });

  it('classifies human handoff blockers before app actions', () => {
    expect(classifyMacTestFlight(root('Omofictions', 'Open', 'Apple ID', 'Password'), 'Omofictions', true)).toMatchObject({ state: 'APPLE_ID_REQUIRED' });
    expect(classifyMacTestFlight(root('Omofictions', 'Verification Code'), 'Omofictions', true)).toMatchObject({ state: 'TWO_FACTOR_REQUIRED' });
    expect(classifyMacTestFlight(root('Terms and Conditions', 'Agree'), 'Omofictions', true)).toMatchObject({ state: 'TERMS_REQUIRED' });
  });

  it('does not invent an app match', () => {
    expect(classifyMacTestFlight(root('Other App', 'Open'), 'Omofictions', true)).toMatchObject({ state: 'APP_NOT_FOUND' });
  });
});
