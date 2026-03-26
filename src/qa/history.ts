import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { AuditReport } from './audit';

export interface RegressionReport {
  currentScore: number;
  previousScore: number;
  scoreDelta: number;
  newIssues: Array<{ detector: string; selector: string; problem: string; fingerprint: string }>;
  fixedIssues: Array<{ detector: string; selector: string; problem: string; fingerprint: string }>;
  recurringIssues: Array<{ detector: string; selector: string; problem: string; fingerprint: string }>;
  summary: string;
}

export class QAHistory {
  private reportsDir: string;

  constructor(reportsDir?: string) {
    this.reportsDir = reportsDir ?? path.join(os.homedir(), '.opensafari', 'reports');
  }

  async save(report: AuditReport): Promise<string> {
    const siteDir = path.join(this.reportsDir, this.sanitizeSite(report.url));
    await fs.mkdir(siteDir, { recursive: true });
    const filename = new Date().toISOString().replace(/[:.]/g, '-') + '.json';
    const filePath = path.join(siteDir, filename);
    await fs.writeFile(filePath, JSON.stringify(report, null, 2));
    await this.rotate(siteDir, 30);
    return filePath;
  }

  async getLatest(url: string): Promise<AuditReport | null> {
    const files = await this.listReportFiles(url);
    if (files.length === 0) return null;
    return JSON.parse(await fs.readFile(files[files.length - 1], 'utf-8'));
  }

  async getPrevious(url: string): Promise<AuditReport | null> {
    const files = await this.listReportFiles(url);
    if (files.length < 2) return null;
    return JSON.parse(await fs.readFile(files[files.length - 2], 'utf-8'));
  }

  async detectRegressions(current: AuditReport, previous: AuditReport): Promise<RegressionReport> {
    const currentFP = this.buildFingerprints(current);
    const previousFP = this.buildFingerprints(previous);

    const newIssues = [...currentFP.values()].filter(i => !previousFP.has(i.fingerprint));
    const fixedIssues = [...previousFP.values()].filter(i => !currentFP.has(i.fingerprint));
    const recurringIssues = [...currentFP.values()].filter(i => previousFP.has(i.fingerprint));

    const scoreDelta = current.score - previous.score;
    const trend = scoreDelta > 0 ? 'improved' : scoreDelta < 0 ? 'regressed' : 'unchanged';

    return {
      currentScore: current.score,
      previousScore: previous.score,
      scoreDelta,
      newIssues,
      fixedIssues,
      recurringIssues,
      summary: `Score ${trend} ${previous.score} -> ${current.score} (${scoreDelta >= 0 ? '+' : ''}${scoreDelta}). ${fixedIssues.length} fixed, ${newIssues.length} new, ${recurringIssues.length} recurring.`,
    };
  }

  getExitCode(report: AuditReport, options?: { failOnCritical?: boolean; failOnHigh?: boolean; minScore?: number }): number {
    const opts = { failOnCritical: true, failOnHigh: false, ...options };
    if (opts.failOnCritical && report.summary.critical > 0) return 1;
    if (opts.failOnHigh && report.summary.high > 0) return 1;
    if (opts.minScore && report.score < opts.minScore) return 1;
    return 0;
  }

  private buildFingerprints(report: AuditReport): Map<string, { detector: string; selector: string; problem: string; fingerprint: string }> {
    const map = new Map<string, { detector: string; selector: string; problem: string; fingerprint: string }>();
    for (const det of report.detectors) {
      for (const issue of det.issues) {
        const fp = this.fingerprint(det.detector, issue.selector);
        map.set(fp, { detector: det.detector, selector: issue.selector, problem: issue.problem, fingerprint: fp });
      }
    }
    return map;
  }

  private fingerprint(detector: string, selector: string): string {
    const input = `${detector}::${selector}`;
    let hash = 0;
    for (let i = 0; i < input.length; i++) {
      hash = ((hash << 5) - hash) + input.charCodeAt(i);
      hash |= 0;
    }
    return hash.toString(36);
  }

  private sanitizeSite(url: string): string {
    try { return new URL(url).hostname.replace(/[^a-zA-Z0-9.-]/g, '_'); }
    catch { return url.replace(/[^a-zA-Z0-9.-]/g, '_'); }
  }

  private async listReportFiles(url: string): Promise<string[]> {
    const siteDir = path.join(this.reportsDir, this.sanitizeSite(url));
    try {
      const files = await fs.readdir(siteDir);
      return files.filter(f => f.endsWith('.json')).sort().map(f => path.join(siteDir, f));
    } catch { return []; }
  }

  private async rotate(dir: string, maxReports: number): Promise<void> {
    try {
      const files = await fs.readdir(dir);
      const sorted = files.filter(f => f.endsWith('.json')).sort();
      if (sorted.length > maxReports) {
        for (const f of sorted.slice(0, sorted.length - maxReports)) {
          await fs.unlink(path.join(dir, f)).catch(() => {});
        }
      }
    } catch { /* */ }
  }
}
