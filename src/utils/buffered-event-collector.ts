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

/** Upper bound on per-session collector maps held by log tools. */
export const MAX_SESSION_COLLECTORS = 32;

/**
 * Get or create a session's collector in a bounded map.
 *
 * Session collectors are deliberately NOT deleted on `stop` (the
 * `stop -> get` sequence must keep working), so the map is bounded instead:
 * when full, the least-recently-used session is evicted. Map insertion order
 * provides the LRU order; access refreshes a session's position.
 */
export function getOrCreateSessionCollector<T extends CollectedEvent>(
  collectors: Map<string, BufferedEventCollector<T>>,
  sessionId: string,
  bufferSize = 500,
): BufferedEventCollector<T> {
  const existing = collectors.get(sessionId);
  if (existing) {
    collectors.delete(sessionId);
    collectors.set(sessionId, existing);
    return existing;
  }
  if (collectors.size >= MAX_SESSION_COLLECTORS) {
    const oldest = collectors.keys().next().value;
    if (oldest !== undefined) collectors.delete(oldest);
  }
  const created = new BufferedEventCollector<T>(bufferSize);
  collectors.set(sessionId, created);
  return created;
}
