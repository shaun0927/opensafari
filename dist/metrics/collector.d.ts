/**
 * Lightweight Prometheus metrics collector.
 * Hand-rolled text format — no prom-client dependency.
 * Supports counters, gauges, and histograms with labels.
 */
export type MetricType = 'counter' | 'gauge' | 'histogram';
export declare class MetricsCollector {
    private counters;
    private gauges;
    private histograms;
    private meta;
    private histogramBuckets;
    /**
     * Register a counter metric.
     */
    registerCounter(name: string, help: string): void;
    /**
     * Register a gauge metric.
     */
    registerGauge(name: string, help: string): void;
    /**
     * Register a histogram metric.
     */
    registerHistogram(name: string, help: string, buckets?: number[]): void;
    /**
     * Increment a counter by 1 (or by a custom amount).
     */
    inc(name: string, labels?: Record<string, string>, amount?: number): void;
    /**
     * Set a gauge to a specific value.
     */
    set(name: string, labels: Record<string, string>, value: number): void;
    /**
     * Observe a value in a histogram.
     */
    observe(name: string, labels: Record<string, string>, value: number): void;
    /**
     * Export all metrics in Prometheus text exposition format.
     */
    export(): string;
}
export declare function getMetricsCollector(): MetricsCollector;
//# sourceMappingURL=collector.d.ts.map