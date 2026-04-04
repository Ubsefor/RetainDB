import type { DiagnosticsStore } from "../core/telemetry.js";
import type { WriteQueue } from "../core/queue.js";

export class AnalyticsModule {
  constructor(
    private readonly diagnostics: DiagnosticsStore,
    private readonly queue: WriteQueue,
  ) {}

  diagnosticsSnapshot() {
    return this.diagnostics.snapshot();
  }

  queueStatus() {
    return this.queue.status();
  }
}
