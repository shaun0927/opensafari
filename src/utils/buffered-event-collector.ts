export interface CollectedEvent {
  timestamp: number;
  [key: string]: unknown;
}

export class BufferedEventCollector<T extends CollectedEvent = CollectedEvent> {
  private buffer: T[] = [];
  private _collecting = false;
  private maxSize: number;

  constructor(maxSize = 500) { this.maxSize = maxSize; }
  get collecting(): boolean { return this._collecting; }
  start(): void { this._collecting = true; }
  stop(): void { this._collecting = false; }

  push(event: T): void {
    if (!this._collecting) return;
    this.buffer.push(event);
    if (this.buffer.length > this.maxSize) this.buffer.shift();
  }

  get(): T[] { return [...this.buffer]; }
  clear(): void { this.buffer = []; }
  get size(): number { return this.buffer.length; }
}
