import type { Context, Next } from "hono";
import { randomUUID } from "crypto";
import {
  getLatencyTraceConfig,
  isLatencyTraceEnabled,
  recordLatencySample,
} from "../engine/latency-tracing.js";

const traceEnabled = isLatencyTraceEnabled();
const traceConfig = getLatencyTraceConfig();

export async function latencyTraceMiddleware(c: Context, next: Next): Promise<void> {
  if (!traceEnabled) {
    await next();
    return;
  }

  const start = Date.now();
  const requestId = c.req.header("x-trace-id") || c.req.header("x-request-id") || randomUUID();
  const method = c.req.method;
  const path = c.req.path;
  let hadError = false;

  try {
    await next();
  } catch (error) {
    hadError = true;
    throw error;
  } finally {
    const durationMs = Date.now() - start;
    const status = c.res?.status || (hadError ? 500 : 0);

    let orgId: string | undefined;
    try {
      const auth = c.get("auth") as { orgId?: string } | undefined;
      orgId = auth?.orgId;
    } catch {
      orgId = undefined;
    }

    recordLatencySample({
      requestId,
      method,
      path,
      status,
      durationMs,
      hadError,
      orgId,
    });

    if (traceConfig.log_all) {
      c.header("x-trace-request-id", requestId);
      c.header("x-trace-latency-ms", String(durationMs));
    } else if (traceConfig.log_slow && durationMs >= traceConfig.slow_threshold_ms) {
      c.header("x-trace-request-id", requestId);
      c.header("x-trace-latency-ms", String(durationMs));
    }
  }
}
