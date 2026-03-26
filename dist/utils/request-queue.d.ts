/**
 * Request Queue - Per-session FIFO queue for sequential request processing
 * Ported from extension with promise-based lock mechanism
 */
export declare class RequestQueue {
    private queue;
    private processingPromise;
    private sessionId;
    constructor(sessionId: string);
    /**
     * Add a function to the queue and return a promise for its result
     */
    enqueue<T>(fn: () => Promise<T>): Promise<T>;
    /**
     * Trigger processing if not already running
     */
    private triggerProcessing;
    /**
     * Process all items in the queue sequentially
     */
    private processQueue;
    get pending(): number;
    get isProcessing(): boolean;
    clear(): void;
    getSessionId(): string;
}
export declare class RequestQueueManager {
    private queues;
    getQueue(sessionId: string): RequestQueue;
    enqueue<T>(sessionId: string, fn: () => Promise<T>): Promise<T>;
    deleteQueue(sessionId: string): void;
    getStats(): Map<string, {
        pending: number;
        processing: boolean;
    }>;
}
//# sourceMappingURL=request-queue.d.ts.map