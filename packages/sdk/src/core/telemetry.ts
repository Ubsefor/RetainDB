import type { DiagnosticsRecord } from "./types.js";

export type DiagnosticsSubscriber = (record: DiagnosticsRecord) => void;

export class DiagnosticsStore {
  private readonly maxEntries: number;
  private readonly records: DiagnosticsRecord[] = [];
  private readonly subscribers = new Set<DiagnosticsSubscriber>();

  constructor(maxEntries = 1000) {
    this.maxEntries = Math.max(1, maxEntries);
  }

  add(record: DiagnosticsRecord): void {
    this.records.push(record);
    if (this.records.length > this.maxEntries) {
      this.records.splice(0, this.records.length - this.maxEntries);
    }
    for (const fn of this.subscribers) {
      try {
        fn(record);
      } catch {
        // Subscriber failures must never impact SDK request flow.
      }
    }
  }

  getLast(limit = 25): DiagnosticsRecord[] {
    const count = Math.max(1, limit);
    return this.records.slice(-count);
  }

  snapshot(): {
    total: number;
    success: number;
    failure: number;
    avgDurationMs: number;
    lastTraceId?: string;
  } {
    const total = this.records.length;
    const success = this.records.filter((r) => r.success).length;
    const failure = total - success;
    const duration = this.records.reduce((acc, item) => acc + item.durationMs, 0);
    return {
      total,
      success,
      failure,
      avgDurationMs: total > 0 ? duration / total : 0,
      lastTraceId: this.records[this.records.length - 1]?.traceId,
    };
  }

  subscribe(fn: DiagnosticsSubscriber): () => void {
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  }
}
