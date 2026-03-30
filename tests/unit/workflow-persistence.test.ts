import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Mock os.homedir before importing the module under test
const TEMP_HOME = path.join(os.tmpdir(), `wf-persist-test-${process.pid}`);

jest.mock('os', () => {
  const actualOs = jest.requireActual('os');
  return {
    ...actualOs,
    homedir: () => TEMP_HOME,
  };
});

import { WorkflowPersistence } from '../../src/orchestration/workflow-persistence';
import { WorkflowState } from '../../src/orchestration/workflow-engine';

const WORKFLOWS_DIR = path.join(TEMP_HOME, '.opensafari', 'workflows');

function makeState(overrides: Partial<WorkflowState> = {}): WorkflowState {
  return {
    id: 'wf-1234',
    status: 'running',
    workers: [
      {
        name: 'worker-iphone15',
        deviceId: 'uuid-abc',
        preset: 'iphone15',
        status: 'pending',
        startedAt: 1000,
      },
    ],
    startedAt: 1000,
    options: { devices: ['iphone15'] },
    ...overrides,
  };
}

describe('WorkflowPersistence', () => {
  let persistence: WorkflowPersistence;

  beforeEach(() => {
    persistence = new WorkflowPersistence();
    // Clean up workflows dir before each test
    if (fs.existsSync(WORKFLOWS_DIR)) {
      const files = fs.readdirSync(WORKFLOWS_DIR);
      for (const file of files) {
        fs.unlinkSync(path.join(WORKFLOWS_DIR, file));
      }
      fs.rmdirSync(WORKFLOWS_DIR);
    }
  });

  afterAll(() => {
    // Clean up temp directory
    if (fs.existsSync(TEMP_HOME)) {
      fs.rmSync(TEMP_HOME, { recursive: true, force: true });
    }
  });

  it('should save and load a workflow state', () => {
    const state = makeState();
    persistence.save(state);
    const loaded = persistence.load('wf-1234');
    expect(loaded).toEqual(state);
  });

  it('should return null for non-existent workflow', () => {
    const loaded = persistence.load('wf-nonexistent');
    expect(loaded).toBeNull();
  });

  it('should load all persisted workflows', () => {
    const state1 = makeState({ id: 'wf-aaa' });
    const state2 = makeState({ id: 'wf-bbb', status: 'completed' });
    persistence.save(state1);
    persistence.save(state2);

    const all = persistence.loadAll();
    expect(all).toHaveLength(2);
    const ids = all.map(s => s.id).sort();
    expect(ids).toEqual(['wf-aaa', 'wf-bbb']);
  });

  it('should remove a workflow state file', () => {
    const state = makeState();
    persistence.save(state);

    // Verify it exists
    expect(persistence.load('wf-1234')).not.toBeNull();

    persistence.remove('wf-1234');
    expect(persistence.load('wf-1234')).toBeNull();
  });

  it('should handle removing non-existent workflow gracefully', () => {
    expect(() => persistence.remove('wf-nonexistent')).not.toThrow();
  });

  it('should overwrite state on re-save', () => {
    const state = makeState();
    persistence.save(state);

    state.status = 'completed';
    state.completedAt = 2000;
    persistence.save(state);

    const loaded = persistence.load('wf-1234');
    expect(loaded!.status).toBe('completed');
    expect(loaded!.completedAt).toBe(2000);
  });

  it('should sanitize workflow ID to prevent path traversal', () => {
    const state = makeState({ id: '../../../etc/passwd' });
    persistence.save(state);

    // The file should be saved with a sanitized name, not traverse directories
    const files = fs.readdirSync(WORKFLOWS_DIR);
    expect(files).toHaveLength(1);
    expect(files[0]).not.toContain('..');
    expect(files[0]).toMatch(/^[a-zA-Z0-9_-]+\.json$/);
  });

  it('should skip corrupt JSON files in loadAll', () => {
    const state = makeState({ id: 'wf-good' });
    persistence.save(state);

    // Write a corrupt file manually
    if (!fs.existsSync(WORKFLOWS_DIR)) {
      fs.mkdirSync(WORKFLOWS_DIR, { recursive: true });
    }
    fs.writeFileSync(path.join(WORKFLOWS_DIR, 'wf-corrupt.json'), 'not valid json{{{', 'utf-8');

    const all = persistence.loadAll();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe('wf-good');
  });

  it('should return null for corrupt single file load', () => {
    // Ensure the directory exists
    if (!fs.existsSync(WORKFLOWS_DIR)) {
      fs.mkdirSync(WORKFLOWS_DIR, { recursive: true });
    }
    fs.writeFileSync(path.join(WORKFLOWS_DIR, 'wf-bad.json'), '{{invalid', 'utf-8');

    const loaded = persistence.load('wf-bad');
    expect(loaded).toBeNull();
  });
});
