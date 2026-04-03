type StatusBucket = "2xx" | "3xx" | "4xx" | "5xx" | "other";
type RetrievalWorkload = "repo_web" | "pdf" | "video" | "plain_text" | "mixed" | "unknown";

interface RouteStat {
  route: string;
  method: string;
  path: string;
  count: number;
  errorCount: number;
  minMs: number;
  maxMs: number;
  totalMs: number;
  statusBuckets: Record<StatusBucket, number>;
  samplesMs: number[];
}

interface StageStat {
  route: string;
  stage: string;
  count: number;
  totalMs: number;
  minMs: number;
  maxMs: number;
  samplesMs: number[];
}

interface RetrievalWorkloadStat {
  workload: RetrievalWorkload;
  count: number;
  cacheHitCount: number;
  totalMs: number;
  minMs: number;
  maxMs: number;
  samplesMs: number[];
  profiles: Record<string, number>;
}

interface SlowRequestEvent {
  timestamp: string;
  requestId: string;
  method: string;
  path: string;
  normalizedPath: string;
  status: number;
  durationMs: number;
  orgId?: string;
  hadError: boolean;
}

interface RecordInput {
  requestId: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  hadError: boolean;
  orgId?: string;
}

interface RouteSummaryRow {
  route: string;
  method: string;
  path: string;
  count: number;
  error_count: number;
  error_rate: number;
  avg_ms: number;
  min_ms: number;
  max_ms: number;
  p50_ms: number;
  p95_ms: number;
  p99_ms: number;
  status_buckets: Record<StatusBucket, number>;
}

const TRACE_ENABLED = /^true$/i.test(process.env.LATENCY_TRACE_ENABLED || "false");
const TRACE_LOG_ALL = /^true$/i.test(process.env.LATENCY_TRACE_LOG_ALL || "false");
const TRACE_LOG_SLOW = !/^false$/i.test(process.env.LATENCY_TRACE_LOG_SLOW || "true");
const SLOW_THRESHOLD_MS = parseInt(process.env.LATENCY_TRACE_SLOW_MS || "1000", 10);
const MAX_ROUTES = parseInt(process.env.LATENCY_TRACE_MAX_ROUTES || "500", 10);
const MAX_SAMPLES_PER_ROUTE = parseInt(process.env.LATENCY_TRACE_SAMPLES_PER_ROUTE || "1000", 10);
const MAX_SLOW_EVENTS = parseInt(process.env.LATENCY_TRACE_MAX_SLOW_EVENTS || "300", 10);

const PROCESS_STARTED_AT = new Date().toISOString();
const routeStats = new Map<string, RouteStat>();
const stageStats = new Map<string, StageStat>();
const retrievalWorkloadStats = new Map<RetrievalWorkload, RetrievalWorkloadStat>();
const slowEvents: SlowRequestEvent[] = [];
let droppedRouteKeys = 0;
let totalRequests = 0;
let totalErrors = 0;

const CORE_MEMORY_ROUTES = [
  "POST /v1/memory",
  "POST /v1/memory/bulk",
  "POST /v1/memory/search",
  "POST /v1/memory/ingest/session",
  "POST /v1/memory/extract/session",
] as const;

const WRITE_ACK_ROUTES = [
  "POST /v1/memory",
  "POST /v1/memory/bulk",
  "POST /v1/memory/ingest/session",
] as const;

const PROFILE_LIST_ROUTES = [
  "GET /v1/memory/profile/:userId",
  "GET /v1/memory/session/:sessionId",
] as const;

const LATENCY_GATE_5XX_THRESHOLD = parseFloat(process.env.LATENCY_GATE_5XX_THRESHOLD || "0.001");
const LATENCY_GATE_SEARCH_P95_MS = parseInt(process.env.LATENCY_GATE_SEARCH_P95_MS || "150", 10);
const LATENCY_GATE_WRITE_ACK_P95_MS = parseInt(process.env.LATENCY_GATE_WRITE_ACK_P95_MS || "40", 10);
const LATENCY_GATE_PROFILE_P95_MS = parseInt(process.env.LATENCY_GATE_PROFILE_P95_MS || "120", 10);
const LATENCY_GATE_MIN_COUNT_DEFAULT = parseInt(process.env.LATENCY_GATE_MIN_COUNT || "20", 10);
const LATENCY_GATE_CONTEXT_REPO_WEB_P50_MS = parseInt(
  process.env.LATENCY_GATE_CONTEXT_REPO_WEB_P50_MS || "200",
  10
);
const LATENCY_GATE_CONTEXT_REPO_WEB_P95_MS = parseInt(
  process.env.LATENCY_GATE_CONTEXT_REPO_WEB_P95_MS || "230",
  10
);
const LATENCY_GATE_CONTEXT_PDF_P50_MS = parseInt(process.env.LATENCY_GATE_CONTEXT_PDF_P50_MS || "350", 10);
const LATENCY_GATE_CONTEXT_VIDEO_P50_MS = parseInt(process.env.LATENCY_GATE_CONTEXT_VIDEO_P50_MS || "320", 10);

function statusBucket(status: number): StatusBucket {
  if (status >= 200 && status < 300) return "2xx";
  if (status >= 300 && status < 400) return "3xx";
  if (status >= 400 && status < 500) return "4xx";
  if (status >= 500 && status < 600) return "5xx";
  return "other";
}

function normalizePath(path: string): string {
  let out = path.split("?")[0];
  out = out.replace(/^\/v1\/memory\/profile\/[^/]+$/i, "/v1/memory/profile/:userId");
  out = out.replace(/^\/v1\/memory\/session\/[^/]+$/i, "/v1/memory/session/:sessionId");
  out = out.replace(/^\/v1\/memory\/jobs\/[^/]+$/i, "/v1/memory/jobs/:jobId");
  out = out.replace(/^\/v1\/memory\/graph\/conversation\/[^/]+$/i, "/v1/memory/graph/conversation/:sessionId");
  out = out.replace(/^\/v1\/memory\/[^/]+\/versions$/i, "/v1/memory/:memoryId/versions");
  out = out.replace(
    /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}/g,
    ":id"
  );
  out = out.replace(/\/\d+(?=\/|$)/g, "/:num");
  out = out.replace(/\/[A-Za-z0-9_-]{24,}(?=\/|$)/g, "/:token");
  return out;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function avg(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function isLatencyTraceEnabled(): boolean {
  return TRACE_ENABLED;
}

export function getLatencyTraceConfig() {
  return {
    enabled: TRACE_ENABLED,
    log_all: TRACE_LOG_ALL,
    log_slow: TRACE_LOG_SLOW,
    slow_threshold_ms: SLOW_THRESHOLD_MS,
    max_routes: MAX_ROUTES,
    max_samples_per_route: MAX_SAMPLES_PER_ROUTE,
    max_slow_events: MAX_SLOW_EVENTS,
  };
}

export function recordLatencySample(input: RecordInput): void {
  if (!TRACE_ENABLED) return;

  totalRequests += 1;
  if (input.hadError || input.status >= 500 || input.status <= 0) {
    totalErrors += 1;
  }

  const normalizedPath = normalizePath(input.path);
  const method = input.method.toUpperCase();
  const routeKey = `${method} ${normalizedPath}`;

  let stat = routeStats.get(routeKey);
  if (!stat) {
    if (routeStats.size >= MAX_ROUTES) {
      droppedRouteKeys += 1;
      return;
    }
    stat = {
      route: routeKey,
      method,
      path: normalizedPath,
      count: 0,
      errorCount: 0,
      minMs: Number.POSITIVE_INFINITY,
      maxMs: 0,
      totalMs: 0,
      statusBuckets: {
        "2xx": 0,
        "3xx": 0,
        "4xx": 0,
        "5xx": 0,
        other: 0,
      },
      samplesMs: [],
    };
    routeStats.set(routeKey, stat);
  }

  stat.count += 1;
  if (input.hadError || input.status >= 500 || input.status <= 0) {
    stat.errorCount += 1;
  }
  stat.minMs = Math.min(stat.minMs, input.durationMs);
  stat.maxMs = Math.max(stat.maxMs, input.durationMs);
  stat.totalMs += input.durationMs;
  stat.statusBuckets[statusBucket(input.status)] += 1;
  stat.samplesMs.push(input.durationMs);
  if (stat.samplesMs.length > MAX_SAMPLES_PER_ROUTE) {
    stat.samplesMs.shift();
  }

  const shouldLogSlow = TRACE_LOG_SLOW && input.durationMs >= SLOW_THRESHOLD_MS;
  const shouldLogAll = TRACE_LOG_ALL;
  if (shouldLogSlow || shouldLogAll) {
    const event: SlowRequestEvent = {
      timestamp: new Date().toISOString(),
      requestId: input.requestId,
      method,
      path: input.path,
      normalizedPath,
      status: input.status,
      durationMs: input.durationMs,
      orgId: input.orgId,
      hadError: input.hadError,
    };

    if (shouldLogSlow) {
      slowEvents.push(event);
      if (slowEvents.length > MAX_SLOW_EVENTS) slowEvents.shift();
      console.warn(`[LatencyTrace] slow_request ${JSON.stringify(event)}`);
    } else {
      console.log(`[LatencyTrace] request ${JSON.stringify(event)}`);
    }
  }
}

export function recordStageBreakdown(route: string, stages: Record<string, number>): void {
  if (!TRACE_ENABLED) return;

  for (const [stage, durationRaw] of Object.entries(stages)) {
    const durationMs = Number(durationRaw);
    if (!Number.isFinite(durationMs) || durationMs < 0) continue;

    const key = `${route}::${stage}`;
    let stat = stageStats.get(key);
    if (!stat) {
      stat = {
        route,
        stage,
        count: 0,
        totalMs: 0,
        minMs: Number.POSITIVE_INFINITY,
        maxMs: 0,
        samplesMs: [],
      };
      stageStats.set(key, stat);
    }

    stat.count += 1;
    stat.totalMs += durationMs;
    stat.minMs = Math.min(stat.minMs, durationMs);
    stat.maxMs = Math.max(stat.maxMs, durationMs);
    stat.samplesMs.push(durationMs);
    if (stat.samplesMs.length > MAX_SAMPLES_PER_ROUTE) {
      stat.samplesMs.shift();
    }
  }
}

export function recordRetrievalWorkloadSample(input: {
  workload: RetrievalWorkload;
  durationMs: number;
  cacheHit?: boolean;
  profile?: string;
}): void {
  if (!TRACE_ENABLED) return;
  if (!Number.isFinite(input.durationMs) || input.durationMs < 0) return;

  let stat = retrievalWorkloadStats.get(input.workload);
  if (!stat) {
    stat = {
      workload: input.workload,
      count: 0,
      cacheHitCount: 0,
      totalMs: 0,
      minMs: Number.POSITIVE_INFINITY,
      maxMs: 0,
      samplesMs: [],
      profiles: {},
    };
    retrievalWorkloadStats.set(input.workload, stat);
  }

  stat.count += 1;
  if (input.cacheHit) stat.cacheHitCount += 1;
  stat.totalMs += input.durationMs;
  stat.minMs = Math.min(stat.minMs, input.durationMs);
  stat.maxMs = Math.max(stat.maxMs, input.durationMs);
  stat.samplesMs.push(input.durationMs);
  if (stat.samplesMs.length > MAX_SAMPLES_PER_ROUTE) {
    stat.samplesMs.shift();
  }

  const profile = (input.profile || "unknown").trim() || "unknown";
  stat.profiles[profile] = (stat.profiles[profile] || 0) + 1;
}

function summarizeRetrievalWorkloads() {
  return [...retrievalWorkloadStats.values()]
    .map((stat) => ({
      workload: stat.workload,
      count: stat.count,
      cache_hit_rate: stat.count > 0 ? stat.cacheHitCount / stat.count : 0,
      avg_ms: stat.count > 0 ? stat.totalMs / stat.count : 0,
      min_ms: stat.minMs === Number.POSITIVE_INFINITY ? 0 : stat.minMs,
      max_ms: stat.maxMs,
      p50_ms: percentile(stat.samplesMs, 50),
      p95_ms: percentile(stat.samplesMs, 95),
      p99_ms: percentile(stat.samplesMs, 99),
      profiles: stat.profiles,
    }))
    .sort((a, b) => b.p95_ms - a.p95_ms);
}

function getStageHotspots(params: { top: number; minCount: number }) {
  const { top, minCount } = params;
  const totalStageP95ByRoute = new Map<string, number>();

  for (const stat of stageStats.values()) {
    if (stat.stage !== "total_ms" || stat.count < minCount) continue;
    totalStageP95ByRoute.set(stat.route, percentile(stat.samplesMs, 95));
  }

  return [...stageStats.values()]
    .filter((stat) => stat.count >= minCount && stat.stage !== "total_ms")
    .map((stat) => {
      const p50 = percentile(stat.samplesMs, 50);
      const p95 = percentile(stat.samplesMs, 95);
      const p99 = percentile(stat.samplesMs, 99);
      const routeP95 = totalStageP95ByRoute.get(stat.route) || 0;
      const p95Share = routeP95 > 0 ? p95 / routeP95 : 0;

      return {
        route: stat.route,
        stage: stat.stage,
        count: stat.count,
        avg_ms: stat.totalMs / stat.count,
        min_ms: stat.minMs === Number.POSITIVE_INFINITY ? 0 : stat.minMs,
        max_ms: stat.maxMs,
        p50_ms: p50,
        p95_ms: p95,
        p99_ms: p99,
        route_p95_ms: routeP95,
        p95_share_of_route: p95Share,
      };
    })
    .sort((a, b) => {
      if (b.p95_share_of_route !== a.p95_share_of_route) {
        return b.p95_share_of_route - a.p95_share_of_route;
      }
      return b.p95_ms - a.p95_ms;
    })
    .slice(0, top);
}

function summarizeRoute(route: RouteStat): RouteSummaryRow {
  const p50 = percentile(route.samplesMs, 50);
  const p95 = percentile(route.samplesMs, 95);
  const p99 = percentile(route.samplesMs, 99);
  return {
    route: route.route,
    method: route.method,
    path: route.path,
    count: route.count,
    error_count: route.errorCount,
    error_rate: route.count > 0 ? route.errorCount / route.count : 0,
    avg_ms: route.count > 0 ? route.totalMs / route.count : 0,
    min_ms: route.minMs === Number.POSITIVE_INFINITY ? 0 : route.minMs,
    max_ms: route.maxMs,
    p50_ms: p50,
    p95_ms: p95,
    p99_ms: p99,
    status_buckets: route.statusBuckets,
  };
}

function buildRouteRows(params: { minCount: number }): RouteSummaryRow[] {
  return [...routeStats.values()]
    .filter((route) => route.count >= params.minCount)
    .map((route) => summarizeRoute(route));
}

function combinedP95ForRoutes(routeKeys: readonly string[]): number {
  const samples: number[] = [];
  for (const key of routeKeys) {
    const stat = routeStats.get(key);
    if (!stat) continue;
    samples.push(...stat.samplesMs);
  }
  return percentile(samples, 95);
}

function aggregateErrorRateForRoutes(routeKeys: readonly string[]) {
  let count = 0;
  let errors = 0;
  for (const key of routeKeys) {
    const stat = routeStats.get(key);
    if (!stat) continue;
    count += stat.count;
    errors += stat.errorCount;
  }
  return {
    count,
    errors,
    error_rate: count > 0 ? errors / count : 0,
  };
}

export function getLatencySummary(params?: {
  top?: number;
  minCount?: number;
  includeSlowEvents?: boolean;
}) {
  const top = params?.top ?? 50;
  const minCount = params?.minCount ?? 1;
  const includeSlowEvents = params?.includeSlowEvents ?? false;

  const routes = buildRouteRows({ minCount })
    .sort((a, b) => b.p95_ms - a.p95_ms)
    .slice(0, top);

  const allSamples = [...routeStats.values()].flatMap((r) => r.samplesMs);
  const allP50 = percentile(allSamples, 50);
  const allP95 = percentile(allSamples, 95);
  const allP99 = percentile(allSamples, 99);
  const stageHotspots = getStageHotspots({ top: 10, minCount });

  return {
    trace: getLatencyTraceConfig(),
    process_started_at: PROCESS_STARTED_AT,
    total_requests: totalRequests,
    total_errors: totalErrors,
    overall_error_rate: totalRequests > 0 ? totalErrors / totalRequests : 0,
    dropped_route_keys: droppedRouteKeys,
    tracked_routes: routeStats.size,
    overall_latency_ms: {
      avg: avg(allSamples),
      p50: allP50,
      p95: allP95,
      p99: allP99,
      min: allSamples.length > 0 ? Math.min(...allSamples) : 0,
      max: allSamples.length > 0 ? Math.max(...allSamples) : 0,
      sample_count: allSamples.length,
    },
    routes,
    retrieval_workloads: summarizeRetrievalWorkloads(),
    stage_hotspots: stageHotspots,
    recent_slow_requests: includeSlowEvents ? [...slowEvents] : undefined,
  };
}

export function getLatencyGateStatus(params?: { minCount?: number }) {
  const minCount = Math.max(params?.minCount ?? LATENCY_GATE_MIN_COUNT_DEFAULT, 1);
  const rows = buildRouteRows({ minCount: 1 });
  const rowMap = new Map(rows.map((row) => [row.route, row] as const));

  const coreRows = CORE_MEMORY_ROUTES
    .map((route) => rowMap.get(route))
    .filter((row): row is RouteSummaryRow => Boolean(row));
  const coreAggregate = aggregateErrorRateForRoutes(CORE_MEMORY_ROUTES);
  const searchP95 = combinedP95ForRoutes(["POST /v1/memory/search"]);
  const writeAckP95 = combinedP95ForRoutes(WRITE_ACK_ROUTES);
  const profileP95 = combinedP95ForRoutes(PROFILE_LIST_ROUTES);

  const core5xxHasSample = coreAggregate.count >= minCount;
  const searchHasSample = aggregateErrorRateForRoutes(["POST /v1/memory/search"]).count >= minCount;
  const writeHasSample = aggregateErrorRateForRoutes(WRITE_ACK_ROUTES).count >= minCount;
  const profileHasSample = aggregateErrorRateForRoutes(PROFILE_LIST_ROUTES).count >= minCount;
  const workloadRows = summarizeRetrievalWorkloads();
  const workloadMap = new Map(workloadRows.map((row) => [row.workload, row] as const));
  const repoWeb = workloadMap.get("repo_web");
  const pdf = workloadMap.get("pdf");
  const video = workloadMap.get("video");

  const gates = {
    core_memory_5xx: {
      pass: core5xxHasSample && coreAggregate.error_rate <= LATENCY_GATE_5XX_THRESHOLD,
      has_sample: core5xxHasSample,
      sample_count: coreAggregate.count,
      error_count: coreAggregate.errors,
      actual_error_rate: coreAggregate.error_rate,
      threshold: LATENCY_GATE_5XX_THRESHOLD,
    },
    search_p95: {
      pass: searchHasSample && searchP95 > 0 && searchP95 <= LATENCY_GATE_SEARCH_P95_MS,
      has_sample: searchHasSample,
      p95_ms: searchP95,
      threshold_ms: LATENCY_GATE_SEARCH_P95_MS,
    },
    write_ack_p95: {
      pass: writeHasSample && writeAckP95 > 0 && writeAckP95 <= LATENCY_GATE_WRITE_ACK_P95_MS,
      has_sample: writeHasSample,
      p95_ms: writeAckP95,
      threshold_ms: LATENCY_GATE_WRITE_ACK_P95_MS,
    },
    profile_list_p95: {
      pass: profileHasSample && profileP95 > 0 && profileP95 <= LATENCY_GATE_PROFILE_P95_MS,
      has_sample: profileHasSample,
      p95_ms: profileP95,
      threshold_ms: LATENCY_GATE_PROFILE_P95_MS,
    },
    context_repo_web_p50: {
      pass: Boolean(repoWeb && repoWeb.count >= minCount && repoWeb.p50_ms <= LATENCY_GATE_CONTEXT_REPO_WEB_P50_MS),
      has_sample: Boolean(repoWeb && repoWeb.count >= minCount),
      sample_count: repoWeb?.count || 0,
      p50_ms: repoWeb?.p50_ms || 0,
      threshold_ms: LATENCY_GATE_CONTEXT_REPO_WEB_P50_MS,
    },
    context_repo_web_p95: {
      pass: Boolean(repoWeb && repoWeb.count >= minCount && repoWeb.p95_ms <= LATENCY_GATE_CONTEXT_REPO_WEB_P95_MS),
      has_sample: Boolean(repoWeb && repoWeb.count >= minCount),
      sample_count: repoWeb?.count || 0,
      p95_ms: repoWeb?.p95_ms || 0,
      threshold_ms: LATENCY_GATE_CONTEXT_REPO_WEB_P95_MS,
    },
    context_pdf_p50: {
      enabled: LATENCY_GATE_CONTEXT_PDF_P50_MS > 0,
      pass: Boolean(
        LATENCY_GATE_CONTEXT_PDF_P50_MS > 0 &&
          pdf &&
          pdf.count >= minCount &&
          pdf.p50_ms <= LATENCY_GATE_CONTEXT_PDF_P50_MS
      ),
      has_sample: Boolean(pdf && pdf.count >= minCount),
      sample_count: pdf?.count || 0,
      p50_ms: pdf?.p50_ms || 0,
      threshold_ms: LATENCY_GATE_CONTEXT_PDF_P50_MS || null,
    },
    context_video_p50: {
      enabled: LATENCY_GATE_CONTEXT_VIDEO_P50_MS > 0,
      pass: Boolean(
        LATENCY_GATE_CONTEXT_VIDEO_P50_MS > 0 &&
          video &&
          video.count >= minCount &&
          video.p50_ms <= LATENCY_GATE_CONTEXT_VIDEO_P50_MS
      ),
      has_sample: Boolean(video && video.count >= minCount),
      sample_count: video?.count || 0,
      p50_ms: video?.p50_ms || 0,
      threshold_ms: LATENCY_GATE_CONTEXT_VIDEO_P50_MS || null,
    },
  };

  return {
    generated_at: new Date().toISOString(),
    process_started_at: PROCESS_STARTED_AT,
    min_count_required: minCount,
    thresholds: {
      core_memory_5xx: LATENCY_GATE_5XX_THRESHOLD,
      search_p95_ms: LATENCY_GATE_SEARCH_P95_MS,
      write_ack_p95_ms: LATENCY_GATE_WRITE_ACK_P95_MS,
      profile_list_p95_ms: LATENCY_GATE_PROFILE_P95_MS,
      context_repo_web_p50_ms: LATENCY_GATE_CONTEXT_REPO_WEB_P50_MS,
      context_repo_web_p95_ms: LATENCY_GATE_CONTEXT_REPO_WEB_P95_MS,
      context_pdf_p50_ms: LATENCY_GATE_CONTEXT_PDF_P50_MS || null,
      context_video_p50_ms: LATENCY_GATE_CONTEXT_VIDEO_P50_MS || null,
    },
    memory_core_routes: coreRows,
    retrieval_workloads: workloadRows,
    gates,
    ready_for_100_rollout:
      gates.core_memory_5xx.pass &&
      gates.search_p95.pass &&
      gates.write_ack_p95.pass &&
      gates.profile_list_p95.pass &&
      gates.context_repo_web_p50.pass &&
      gates.context_repo_web_p95.pass,
  };
}

export function resetLatencySummary(): { reset: true; timestamp: string } {
  routeStats.clear();
  stageStats.clear();
  retrievalWorkloadStats.clear();
  slowEvents.length = 0;
  droppedRouteKeys = 0;
  totalRequests = 0;
  totalErrors = 0;
  return {
    reset: true,
    timestamp: new Date().toISOString(),
  };
}
