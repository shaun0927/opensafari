/**
 * Production {@link TempFileWriter} backed by `fs.promises`.
 *
 * Kept isolated from the blocker modules so unit tests can import the
 * blockers without pulling in any Node filesystem code, and so the tool
 * layer can inject a test writer that returns deterministic paths.
 */

import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

import { TempFileWriter } from './types';

export interface RealTempFileWriterOptions {
  /** Directory name prefix for `fs.mkdtemp`. */
  prefix?: string;
  /** Override the base tmp directory (tests). */
  baseDir?: string;
}

export class RealTempFileWriter implements TempFileWriter {
  private readonly prefix: string;
  private readonly baseDir: string;

  constructor(opts: RealTempFileWriterOptions = {}) {
    this.prefix = opts.prefix ?? 'opensafari-pfctl-';
    this.baseDir = opts.baseDir ?? os.tmpdir();
  }

  async write(contents: string): Promise<string> {
    const dir = await fs.mkdtemp(path.join(this.baseDir, this.prefix));
    const file = path.join(dir, 'rules.conf');
    await fs.writeFile(file, contents, { mode: 0o644 });
    return file;
  }

  async remove(filePath: string): Promise<void> {
    try {
      await fs.unlink(filePath);
    } catch {
      // already gone — acceptable
    }
    try {
      await fs.rmdir(path.dirname(filePath));
    } catch {
      // non-empty or already gone — acceptable
    }
  }
}
