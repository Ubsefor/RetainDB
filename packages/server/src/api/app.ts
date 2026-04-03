import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { randomUUID } from "crypto";
import { latencyTraceMiddleware } from "../middleware/latency-trace.js";

const STACK_NAME = process.env.RETAINDB_STACK || "ec2";

export function getTraceIdFromRequest(c: { req: { header: (name: string) => string | undefined } }) {
  return c.req.header("x-trace-id") || c.req.header("x-request-id") || randomUUID();
}

export function bigIntJson(value: any): any {
  if (value === null || value === undefined) return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(bigIntJson);
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, bigIntJson(entry)]));
  }
  return value;
}

function errorPayload(params: {
  code: string;
  message: string;
  traceId: string;
  details?: string;
}) {
  return bigIntJson({
    success: false,
    error: {
      code: params.code,
      message: params.message,
      ...(params.details ? { details: params.details } : {}),
    },
    trace_id: params.traceId,
  });
}

async function parseErrorResponse(response: Response) {
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) return {};
  try {
    const payload = await response.clone().json() as any;
    return {
      code:
        payload?.error?.code ||
        (typeof payload?.error === "string" ? payload.error : "") ||
        payload?.code ||
        "",
      message:
        payload?.error?.message ||
        (typeof payload?.error === "string" ? payload.error : "") ||
        payload?.message ||
        "",
      details: payload?.error?.details || payload?.details || "",
    };
  } catch {
    return {};
  }
}


export function createNodeApp(options: { includeApiRoutes?: boolean; routeApp?: Hono<any, any, any> } = {}) {
  const { includeApiRoutes = true, routeApp } = options;
  const app = new Hono();

  app.use("*", cors());
  app.use("*", logger());
  app.use("*", async (c, next) => {
    const traceId = getTraceIdFromRequest(c);
    c.header("x-trace-id", traceId);
    c.header("x-request-id", traceId);
    await next();
  });
  app.use("*", latencyTraceMiddleware);
  app.use("*", async (c, next) => {
    c.header("x-retaindb-stack", STACK_NAME);
    await next();
  });

  app.get("/", (c) => {
    return c.json({
      name: "RetainDB - SOTA Memory & Context System",
      version: "2.1.0",
      docs: "https://context.retaindb.com/docs",
      message: "Canonical memory API: use /v1/memory* endpoints. Legacy /v1/memories* routes remain available with deprecation headers.",
      endpoints: {
        query: "POST /v1/context/query",
        oracle_search: "POST /v1/oracle/search",
        autosubscribe: "POST /v1/autosubscribe",
        context_share: "POST /v1/context/share",
        context_resume: "POST /v1/context/resume",
        memory_write: "POST /v1/memory",
        memory_bulk: "POST /v1/memory/bulk",
        memory_search: "POST /v1/memory/search",
        memory_ingest: "POST /v1/memory/ingest/session",
        memory_jobs: "GET /v1/memory/jobs/:jobId",
        memory_versions: "GET /v1/memory/:id/versions",
        memory_relations: "GET /v1/memory/:id/relations",
        user_profile: "GET /v1/memory/profile/:userId",
        session_memories: "GET /v1/memory/session/:sessionId",
        update_memory: "PUT /v1/memory/:memoryId",
        delete_memory: "DELETE /v1/memory/:memoryId",
        consolidate: "POST /v1/memory/consolidate",
        decay_update: "POST /v1/memory/decay/update",
        cache_stats: "GET /v1/cache/stats",
        cost_summary: "GET /v1/cost/summary",
        cost_savings: "GET /v1/cost/savings",
        projects: "GET /v1/projects",
        sources: "POST /v1/projects/:id/sources",
        add_source: "POST /v1/projects/:id/add_source",
        source_status: "GET /v1/sources/:id/status",
        ingest: "POST /v1/projects/:id/ingest",
        learn: "POST /v1/learn",
        index: "POST /v1/index",
        index_bundle: "POST /v1/index/bundle",
        sync: "POST /v1/sources/:id/sync",
        webhooks: "POST /v1/webhooks",
      },
    });
  });

  app.get("/health", (c) => c.json({ status: "ok" }));
  if (includeApiRoutes && routeApp) {
    app.route("/", routeApp);
  }

  app.notFound((c) => {
    const traceId = getTraceIdFromRequest(c);
    return c.json(
      errorPayload({
        code: "NOT_FOUND",
        message: "Route not found",
        traceId,
      }),
      404
    );
  });

  app.onError((err, c) => {
    const traceId = getTraceIdFromRequest(c);
    console.error(`[${traceId}] Unhandled error:`, err);
    return c.json(
      errorPayload({
        code: "INTERNAL_ERROR",
        message: "Internal server error",
        traceId,
        details: err instanceof Error ? err.message : String(err),
      }),
      500
    );
  });

  return app;
}
