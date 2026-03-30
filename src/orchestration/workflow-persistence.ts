import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { WorkflowState } from './workflow-engine';

const WORKFLOWS_DIR = path.join(os.homedir(), '.opensafari', 'workflows');

function ensureDir(): void {
  if (!fs.existsSync(WORKFLOWS_DIR)) {
    fs.mkdirSync(WORKFLOWS_DIR, { recursive: true });
  }
}

function workflowPath(id: string): string {
  const safe = id.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(WORKFLOWS_DIR, `${safe}.json`);
}

export class WorkflowPersistence {
  save(state: WorkflowState): void {
    ensureDir();
    const filePath = workflowPath(state.id);
    fs.writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf-8');
  }

  load(id: string): WorkflowState | null {
    const filePath = workflowPath(id);
    if (!fs.existsSync(filePath)) return null;
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(raw) as WorkflowState;
    } catch {
      return null;
    }
  }

  loadAll(limit = 100): WorkflowState[] {
    ensureDir();
    const files = fs.readdirSync(WORKFLOWS_DIR).filter(f => f.endsWith('.json'));
    if (files.length > limit) {
      console.error(`WorkflowPersistence: ${files.length} workflow files found, loading only ${limit} most recent`);
    }
    const states: WorkflowState[] = [];
    for (const file of files.slice(0, limit)) {
      try {
        const raw = fs.readFileSync(path.join(WORKFLOWS_DIR, file), 'utf-8');
        states.push(JSON.parse(raw) as WorkflowState);
      } catch {
        console.error(`WorkflowPersistence: skipping corrupt file ${file}`);
      }
    }
    return states;
  }

  remove(id: string): void {
    const filePath = workflowPath(id);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }
}
