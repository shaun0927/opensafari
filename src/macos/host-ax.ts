import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const execFileAsync = promisify(execFile);
const TIMEOUT = 20_000;

export interface HostAXNode {
  role: string;
  label?: string;
  value?: string;
  identifier?: string;
  frame: { x: number; y: number; width: number; height: number };
  visible: boolean;
  enabled: boolean;
  focused: boolean;
  actions: string[];
  path: string;
  children?: HostAXNode[];
}

export interface HostAXTarget { bundleId?: string; processName?: string }
export interface HostAXQuery { identifier?: string; label?: string; text?: string; role?: string; index?: number }

async function helperPath(): Promise<string> {
  const candidates = [
    path.resolve(__dirname, '..', 'host-ax-native'),
    path.resolve(__dirname, 'host-ax-native'),
    path.resolve(__dirname, '..', 'host-ax.swift'),
    path.resolve(__dirname, 'host-ax.swift'),
    path.resolve(__dirname, '..', '..', 'src', 'macos', 'host-ax.swift'),
  ];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) throw new Error(`host-ax helper not found. Run npm run build. Searched: ${candidates.join(', ')}`);
  return found;
}

function targetArgs(t: HostAXTarget): string[] {
  if (t.bundleId) return ['--bundle-id', t.bundleId];
  if (t.processName) return ['--process-name', t.processName];
  throw new Error('bundleId or processName is required');
}

async function run<T>(args: string[]): Promise<T> {
  const bin = await helperPath();
  const { stdout } = await execFileAsync(bin, args, { timeout: TIMEOUT, maxBuffer: 20 * 1024 * 1024 });
  const parsed = JSON.parse(stdout) as T & { error?: string; code?: string };
  if (parsed && parsed.error) throw new Error(`${parsed.code ?? 'HOST_AX_ERROR'}: ${parsed.error}`);
  return parsed as T;
}

export async function launchHostApp(input: HostAXTarget & { path?: string; waitMs?: number }): Promise<Record<string, unknown>> {
  const args = input.bundleId ? ['-b', input.bundleId] : input.path ? [input.path] : [];
  if (!args.length) throw new Error('bundleId or path is required');
  await execFileAsync('/usr/bin/open', args, { timeout: TIMEOUT });
  await sleep(input.waitMs ?? 1000);
  return { launched: true, bundleId: input.bundleId, path: input.path };
}

export async function dumpHostTree(target: HostAXTarget & { maxDepth?: number }): Promise<HostAXNode> {
  return run<HostAXNode>(['dump', ...targetArgs(target), '--max-depth', String(target.maxDepth ?? 8)]);
}

export function queryHostTree(root: HostAXNode, q: HostAXQuery): HostAXNode[] {
  const matches: HostAXNode[] = [];
  const needle = (s?: string) => (s ?? '').normalize('NFKC').toLowerCase();
  const contains = (hay?: string, n?: string) => !!n && needle(hay).includes(needle(n));
  const visit = (n: HostAXNode) => {
    if ((!q.identifier || needle(n.identifier) === needle(q.identifier)) &&
        (!q.label || contains(n.label, q.label)) &&
        (!q.text || contains(n.label, q.text) || contains(n.value, q.text) || contains(n.identifier, q.text)) &&
        (!q.role || needle(n.role) === needle(q.role))) matches.push(n);
    for (const child of n.children ?? []) visit(child);
  };
  visit(root);
  return matches;
}

export async function pressHostElement(target: HostAXTarget, pathValue: string): Promise<Record<string, unknown>> {
  return run<Record<string, unknown>>(['press', ...targetArgs(target), '--path', pathValue]);
}

export async function clickHostPoint(x: number, y: number): Promise<Record<string, unknown>> {
  return run<Record<string, unknown>>(['click', '--x', String(x), '--y', String(y)]);
}

export async function hostScreenshot(artifactDir?: string, name = 'mac-host-screenshot.png'): Promise<string> {
  const dir = artifactDir ?? await fsp.mkdtemp(path.join(os.tmpdir(), 'opensafari-mac-'));
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, name);
  await execFileAsync('/usr/sbin/screencapture', ['-x', file], { timeout: TIMEOUT });
  return file;
}

export async function collectHostBundle(target: HostAXTarget & { artifactDir?: string; maxDepth?: number; label?: string }): Promise<Record<string, unknown>> {
  const dir = target.artifactDir ?? await fsp.mkdtemp(path.join(os.tmpdir(), 'opensafari-mac-bundle-'));
  await fsp.mkdir(dir, { recursive: true });
  const tree = await dumpHostTree(target);
  const treePath = path.join(dir, 'ax-tree.json');
  await fsp.writeFile(treePath, JSON.stringify(tree, null, 2));
  const screenshotPath = await hostScreenshot(dir);
  const logPath = path.join(dir, 'recent-log.txt');
  try {
    const predicate = target.bundleId ? `process == "${target.bundleId}"` : 'eventMessage CONTAINS[c] "StoreKit" OR eventMessage CONTAINS[c] "TestFlight"';
    const { stdout } = await execFileAsync('/usr/bin/log', ['show', '--last', '5m', '--style', 'compact', '--predicate', predicate], { timeout: 10_000, maxBuffer: 2 * 1024 * 1024 });
    await fsp.writeFile(logPath, stdout.slice(-200_000));
  } catch { await fsp.writeFile(logPath, 'log unavailable\n'); }
  return { artifactDir: dir, treePath, screenshotPath, logPath };
}

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }
