import type { AllocationEntry } from '../tools/flutter-memory-profile';

export interface FlutterMemoryBudget {
  maxTotalDeltaBytes?: number;
  maxClassDeltaBytes?: number;
  maxClassDeltaInstances?: number;
  ignoreClassPatterns?: string[];
}

export interface FlutterMemoryBudgetViolation {
  className: string;
  deltaBytes: number;
  deltaInstances: number;
  reason: string;
}

export interface FlutterMemoryBudgetReport {
  status: 'pass' | 'fail';
  checkedClasses: number;
  ignoredClasses: number;
  totalDeltaBytes: number;
  topGrowingClasses: Array<{ className: string; deltaBytes: number; deltaInstances: number }>;
  violations: FlutterMemoryBudgetViolation[];
}

export function evaluateFlutterMemoryBudget(
  entries: AllocationEntry[],
  budget: FlutterMemoryBudget,
): FlutterMemoryBudgetReport {
  const ignorePatterns = (budget.ignoreClassPatterns ?? []).map((pattern) => new RegExp(pattern));
  let ignoredClasses = 0;
  const considered = entries.filter((entry) => {
    const ignored = ignorePatterns.some((pattern) => pattern.test(entry.class));
    if (ignored) ignoredClasses += 1;
    return !ignored;
  });

  const growth = considered
    .map((entry) => ({
      className: entry.class,
      deltaBytes: Math.max(0, entry.delta_bytes ?? 0),
      deltaInstances: Math.max(0, entry.delta_instances ?? 0),
    }))
    .filter((entry) => entry.deltaBytes > 0 || entry.deltaInstances > 0)
    .sort((a, b) => b.deltaBytes - a.deltaBytes || b.deltaInstances - a.deltaInstances);

  const totalDeltaBytes = growth.reduce((sum, entry) => sum + entry.deltaBytes, 0);
  const violations: FlutterMemoryBudgetViolation[] = [];

  if (budget.maxTotalDeltaBytes !== undefined && totalDeltaBytes > budget.maxTotalDeltaBytes) {
    violations.push({
      className: '*',
      deltaBytes: totalDeltaBytes,
      deltaInstances: growth.reduce((sum, entry) => sum + entry.deltaInstances, 0),
      reason: `total positive delta ${totalDeltaBytes} bytes exceeds budget ${budget.maxTotalDeltaBytes}`,
    });
  }

  for (const entry of growth) {
    if (budget.maxClassDeltaBytes !== undefined && entry.deltaBytes > budget.maxClassDeltaBytes) {
      violations.push({
        ...entry,
        reason: `class byte delta ${entry.deltaBytes} exceeds budget ${budget.maxClassDeltaBytes}`,
      });
    }
    if (budget.maxClassDeltaInstances !== undefined && entry.deltaInstances > budget.maxClassDeltaInstances) {
      violations.push({
        ...entry,
        reason: `class instance delta ${entry.deltaInstances} exceeds budget ${budget.maxClassDeltaInstances}`,
      });
    }
  }

  return {
    status: violations.length === 0 ? 'pass' : 'fail',
    checkedClasses: considered.length,
    ignoredClasses,
    totalDeltaBytes,
    topGrowingClasses: growth.slice(0, 20),
    violations,
  };
}
