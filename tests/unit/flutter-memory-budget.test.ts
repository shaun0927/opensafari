import { evaluateFlutterMemoryBudget } from '../../src/metrics/flutter-memory-budget';
import type { AllocationEntry } from '../../src/tools/flutter-memory-profile';

describe('evaluateFlutterMemoryBudget', () => {
  const entries: AllocationEntry[] = [
    { class: 'LeakyWidgetState', instances_current: 10, bytes_current: 1000, delta_instances: 6, delta_bytes: 900 },
    { class: '_InternalNoise', instances_current: 20, bytes_current: 2000, delta_instances: 20, delta_bytes: 5000 },
    { class: 'StableWidget', instances_current: 1, bytes_current: 100, delta_instances: -1, delta_bytes: -100 },
  ];

  it('passes when positive growth stays under configured budgets', () => {
    const report = evaluateFlutterMemoryBudget(entries, {
      maxTotalDeltaBytes: 6000,
      maxClassDeltaBytes: 1000,
      maxClassDeltaInstances: 10,
      ignoreClassPatterns: ['^_Internal'],
    });
    expect(report.status).toBe('pass');
    expect(report.ignoredClasses).toBe(1);
    expect(report.totalDeltaBytes).toBe(900);
  });

  it('reports total and per-class budget violations', () => {
    const report = evaluateFlutterMemoryBudget(entries, {
      maxTotalDeltaBytes: 1000,
      maxClassDeltaBytes: 800,
      maxClassDeltaInstances: 5,
      ignoreClassPatterns: ['^_Internal'],
    });
    expect(report.status).toBe('fail');
    expect(report.violations.map((v) => v.className)).toEqual(['LeakyWidgetState', 'LeakyWidgetState']);
  });

  it('keeps the top growing classes sorted by byte delta', () => {
    const report = evaluateFlutterMemoryBudget(entries, {});
    expect(report.topGrowingClasses[0].className).toBe('_InternalNoise');
    expect(report.topGrowingClasses[1].className).toBe('LeakyWidgetState');
  });
});
