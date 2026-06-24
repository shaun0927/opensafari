import { classifyTestFlightIap } from '../../src/tools/testflight-iap-classifier';
import type { VisibleNodeSummary } from '../../src/tools/app-state-snapshot';

const tfInstalled = ['com.apple.TestFlight'];
const nodes = (...labels: string[]): VisibleNodeSummary[] => labels.map((label) => ({ role: 'AXButton', label }));

function expectPhase(labels: string[], phase: ReturnType<typeof classifyTestFlightIap>['phase']) {
  const result = classifyTestFlightIap({ visibleSummary: nodes(...labels), installedBundleIds: tfInstalled });
  expect(result).toMatchObject({ phase });
  expect(result.reason).toBeTruthy();
  expect(result.nextSafeAction).toBeTruthy();
  expect(result.matchedSignals.length).toBeGreaterThan(0);
  return result;
}

describe('classifyTestFlightIap', () => {
  it('reports TestFlight not installed', () => {
    const result = classifyTestFlightIap({ visibleSummary: nodes('Home'), installedBundleIds: [] });
    expect(result).toMatchObject({ phase: 'TESTFLIGHT_NOT_INSTALLED', blocker: 'TESTFLIGHT_MISSING', confidence: 'high' });
  });

  it('classifies TestFlight visible with Install', () => {
    expectPhase(['TestFlight', 'Install'], 'TESTFLIGHT_INSTALL_AVAILABLE');
  });

  it('classifies TestFlight visible with Update', () => {
    expectPhase(['TestFlight', 'Update'], 'TESTFLIGHT_UPDATE_AVAILABLE');
  });

  it('classifies TestFlight visible with Open', () => {
    expectPhase(['TestFlight', 'Open'], 'TESTFLIGHT_OPEN_AVAILABLE');
  });

  it('classifies Apple ID sign-in required', () => {
    const result = expectPhase(['Apple ID', 'Sign In'], 'APPLE_ID_SIGN_IN_REQUIRED');
    expect(result.blocker).toBe('APPLE_ID_AUTH');
  });

  it('classifies 2FA required', () => {
    expectPhase(['Two-Factor Authentication', 'Verification Code'], 'TWO_FACTOR_REQUIRED');
  });

  it('classifies sandbox sign-in required', () => {
    expectPhase(['Sandbox Account', 'Sign In'], 'SANDBOX_SIGN_IN_REQUIRED');
  });

  it('classifies StoreKit purchase sheet visible', () => {
    expectPhase(['In-App Purchase', 'Subscribe', 'Confirm'], 'STOREKIT_PURCHASE_SHEET_VISIBLE');
  });

  it('classifies purchase success visible', () => {
    expectPhase(['Purchase Successful', 'Done'], 'PURCHASE_SUCCESS_VISIBLE');
  });

  it('classifies unknown state with evidence instead of success', () => {
    const result = classifyTestFlightIap({ visibleSummary: nodes('Welcome', 'Try again later'), installedBundleIds: tfInstalled });
    expect(result).toMatchObject({ phase: 'UNKNOWN_WITH_EVIDENCE', blocker: 'UNKNOWN', confidence: 'low' });
    expect(result.matchedSignals).toEqual(expect.arrayContaining(['AXButton Welcome']));
  });
});
