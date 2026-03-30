import { EventEmitter } from 'events';

export interface CircuitBreakerOptions {
  failureThreshold: number;
  cooldownMs: number;
  halfOpenMaxAttempts: number;
}

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface StateChangeEvent {
  deviceId: string;
  from: CircuitState;
  to: CircuitState;
  error?: Error;
}

const DEFAULT_OPTIONS: CircuitBreakerOptions = {
  failureThreshold: 3,
  cooldownMs: 30000,
  halfOpenMaxAttempts: 1,
};

export class CircuitBreaker extends EventEmitter {
  private state: CircuitState = 'closed';
  private failureCount = 0;
  private lastFailureTime = 0;
  private halfOpenAttempts = 0;
  private readonly options: CircuitBreakerOptions;

  constructor(
    private readonly deviceId: string,
    options?: Partial<CircuitBreakerOptions>,
  ) {
    super();
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  getState(): CircuitState { return this.state; }
  getFailureCount(): number { return this.failureCount; }
  getDeviceId(): string { return this.deviceId; }

  recordSuccess(): void {
    if (this.state === 'half-open' || this.state === 'closed') {
      const prev = this.state;
      this.state = 'closed';
      this.failureCount = 0;
      this.halfOpenAttempts = 0;
      if (prev !== 'closed') {
        this.emit('state-change', { deviceId: this.deviceId, from: prev, to: 'closed' } as StateChangeEvent);
      }
    }
  }

  recordFailure(error?: Error): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.state === 'half-open') {
      this.state = 'open';
      this.halfOpenAttempts = 0;
      this.emit('state-change', { deviceId: this.deviceId, from: 'half-open', to: 'open', error } as StateChangeEvent);
      return;
    }

    if (this.state === 'closed' && this.failureCount >= this.options.failureThreshold) {
      this.state = 'open';
      this.emit('state-change', { deviceId: this.deviceId, from: 'closed', to: 'open', error } as StateChangeEvent);
    }
  }

  isAvailable(): boolean {
    if (this.state === 'closed') return true;

    if (this.state === 'open') {
      if (Date.now() - this.lastFailureTime >= this.options.cooldownMs) {
        this.state = 'half-open';
        this.halfOpenAttempts = 1;
        this.emit('state-change', { deviceId: this.deviceId, from: 'open', to: 'half-open' } as StateChangeEvent);
        return true;
      }
      return false;
    }

    if (this.halfOpenAttempts < this.options.halfOpenMaxAttempts) {
      this.halfOpenAttempts++;
      return true;
    }
    return false;
  }

  reset(): void {
    const prev = this.state;
    this.state = 'closed';
    this.failureCount = 0;
    this.halfOpenAttempts = 0;
    this.lastFailureTime = 0;
    if (prev !== 'closed') {
      this.emit('state-change', { deviceId: this.deviceId, from: prev, to: 'closed' } as StateChangeEvent);
    }
  }

  trip(): void {
    const prev = this.state;
    this.state = 'open';
    this.lastFailureTime = Date.now();
    if (prev !== 'open') {
      this.emit('state-change', { deviceId: this.deviceId, from: prev, to: 'open' } as StateChangeEvent);
    }
  }
}

export class CircuitBreakerRegistry {
  private breakers = new Map<string, CircuitBreaker>();
  private readonly defaultOptions: Partial<CircuitBreakerOptions>;

  constructor(options?: Partial<CircuitBreakerOptions>) {
    this.defaultOptions = options ?? {};
  }

  get(deviceId: string): CircuitBreaker {
    let cb = this.breakers.get(deviceId);
    if (!cb) {
      cb = new CircuitBreaker(deviceId, this.defaultOptions);
      this.breakers.set(deviceId, cb);
    }
    return cb;
  }

  remove(deviceId: string): void { this.breakers.delete(deviceId); }

  getAvailableDeviceIds(): string[] {
    return [...this.breakers.entries()].filter(([, cb]) => cb.isAvailable()).map(([id]) => id);
  }

  getAllStates(): Map<string, CircuitState> {
    const states = new Map<string, CircuitState>();
    for (const [id, cb] of this.breakers) { states.set(id, cb.getState()); }
    return states;
  }

  resetAll(): void {
    for (const cb of this.breakers.values()) { cb.reset(); }
  }
}
