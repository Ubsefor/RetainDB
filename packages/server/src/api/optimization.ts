/**
 * Optimization API Routes
 * Endpoints for memory consolidation, importance decay, cache management, and cost tracking
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { prisma } from "../db/index.js";
import type { AuthContext } from "../middleware/auth.js";
import { rateLimitMiddleware, RateLimits } from "../middleware/rate-limit.js";
import {
  findDuplicateMemories,
  mergeDuplicateMemories,
  consolidateMemories,
} from "../engine/memory/consolidation.js";
import {
  updateImportanceScores,
  getImportanceStats,
  archiveLowImportanceMemories,
} from "../engine/memory/importance-decay.js";
import {
  getCacheStats,
  warmCache,
  clearCacheByPattern,
} from "../engine/cache.js";
import {
  getCostSummary,
  getCostBreakdown,
  getSavingsReport,
} from "../engine/cost-optimization.js";
import { ensureProject, resolveProjectReference } from "./helpers.js";

type Variables = {
  auth: AuthContext;
};

export const optimizationRoutes = new Hono<{ Variables: Variables }>();

// ──────────────────────────────────────────────────────────────
// Memory Consolidation - Find and merge duplicate memories
// ──────────────────────────────────────────────────────────────

optimizationRoutes.post(
  "/v1/memory/consolidate",
  rateLimitMiddleware(RateLimits.mutation),
  zValidator(
    "json",
    z.object({
      project: z.string().optional(),
      similarity_threshold: z.number().min(0.8).max(1.0).optional().default(0.95),
      auto_merge: z.boolean().optional().default(false),
      dry_run: z.boolean().optional().default(false),
    })
  ),
  async (c) => {
    const auth = c.get("auth");
    const body = c.req.valid("json");

    try {
      const project = await ensureProject(auth.orgId, body.project, auth.isAdmin);

      if (body.dry_run) {
        // Just find duplicates, don't merge
        const clusters = await findDuplicateMemories({
          projectId: project.id,
          similarityThreshold: body.similarity_threshold,
        });

        return c.json({
          dry_run: true,
          clusters_found: clusters.length,
          total_duplicates: clusters.reduce((sum, c) => sum + c.duplicates.length, 0),
          estimated_savings: clusters.reduce((sum, c) => sum + c.duplicates.length, 0),
          clusters: clusters.map((cluster) => ({
            representative: cluster.representative.content.slice(0, 100),
            duplicates_count: cluster.duplicates.length,
            average_similarity: cluster.similarity,
          })),
        });
      }

      // Run consolidation
      const result = await consolidateMemories({
        projectId: project.id,
        similarityThreshold: body.similarity_threshold,
      });

      return c.json({
        success: true,
        clusters_processed: result.clustersFound,
        memories_merged: result.memoriesMerged,
        memories_deactivated: result.memoriesDeactivated,
      });
    } catch (error) {
      console.error("Consolidation error:", error);
      return c.json({ error: "Memory consolidation failed" }, 500);
    }
  }
);

// ──────────────────────────────────────────────────────────────
// Update Importance Scores - Apply time-based decay
// ──────────────────────────────────────────────────────────────

optimizationRoutes.post(
  "/v1/memory/decay/update",
  rateLimitMiddleware(RateLimits.mutation),
  zValidator(
    "json",
    z.object({
      project: z.string().optional(),
      decay_function: z.enum(["exponential", "linear", "logarithmic"]).optional().default("exponential"),
      half_life_days: z.number().min(1).max(365).optional().default(30),
      access_boost: z.number().min(0).max(1).optional().default(0.2),
      auto_archive: z.boolean().optional().default(false),
      archive_threshold: z.number().min(0).max(1).optional().default(0.1),
    })
  ),
  async (c) => {
    const auth = c.get("auth");
    const body = c.req.valid("json");

    try {
      const project = await ensureProject(auth.orgId, body.project, auth.isAdmin);

      // Update importance scores
      const updateResult = await updateImportanceScores({
        projectId: project.id,
        config: {
          decayFunction: body.decay_function,
          halfLifeDays: body.half_life_days,
          accessBoost: body.access_boost,
        },
      });

      let archiveResult;
      if (body.auto_archive) {
        archiveResult = await archiveLowImportanceMemories({
          projectId: project.id,
          importanceThreshold: body.archive_threshold,
        });
      }

      return c.json({
        success: true,
        memories_updated: updateResult.updated,
        average_importance: updateResult.avgImportance,
        memories_archived: archiveResult?.archived || 0,
        config: {
          decay_function: body.decay_function,
          half_life_days: body.half_life_days,
          access_boost: body.access_boost,
        },
      });
    } catch (error) {
      console.error("Importance decay update error:", error);
      return c.json({ error: "Failed to update importance scores" }, 500);
    }
  }
);

// ──────────────────────────────────────────────────────────────
// Get Importance Statistics
// ──────────────────────────────────────────────────────────────

optimizationRoutes.get(
  "/v1/memory/decay/stats",
  rateLimitMiddleware(RateLimits.query),
  zValidator(
    "query",
    z.object({
      project: z.string().optional(),
    })
  ),
  async (c) => {
    const auth = c.get("auth");
    const query = c.req.valid("query");

    try {
      const project = await ensureProject(auth.orgId, query.project, auth.isAdmin);

      const stats = await getImportanceStats(project.id);

      return c.json({
        project_id: project.id,
        statistics: {
          total_memories: stats.total,
          average_importance: stats.avgImportance,
          importance_distribution: stats.distribution,
          low_importance_count: stats.distribution.low,
          high_importance_count: stats.distribution.high,
        },
      });
    } catch (error) {
      console.error("Get importance stats error:", error);
      return c.json({ error: "Failed to get importance statistics" }, 500);
    }
  }
);

// ──────────────────────────────────────────────────────────────
// Cache Statistics
// ──────────────────────────────────────────────────────────────

optimizationRoutes.get(
  "/v1/cache/stats",
  rateLimitMiddleware(RateLimits.query),
  async (c) => {
    const auth = c.get("auth");

    try {
      const stats = await getCacheStats();

      return c.json({
        hit_rate: stats.hitRate,
        hits: stats.hits,
        misses: stats.misses,
        keys_count: stats.size,
      });
    } catch (error) {
      console.error("Get cache stats error:", error);
      return c.json({ error: "Failed to get cache statistics" }, 500);
    }
  }
);

// ──────────────────────────────────────────────────────────────
// Warm Cache - Preload common queries
// ──────────────────────────────────────────────────────────────

optimizationRoutes.post(
  "/v1/cache/warm",
  rateLimitMiddleware(RateLimits.mutation),
  zValidator(
    "json",
    z.object({
      project: z.string().optional(),
      queries: z.array(z.string()).min(1).max(50),
      ttl_seconds: z.number().int().min(60).max(86400).optional().default(3600),
    })
  ),
  async (c) => {
    const auth = c.get("auth");
    const body = c.req.valid("json");

    try {
      const project = await ensureProject(auth.orgId, body.project, auth.isAdmin);

      const result = await warmCache({
        projectId: project.id,
        commonQueries: body.queries,
      });

      return c.json({
        success: true,
        queries_warmed: result.cached,
        errors: result.failed,
      });
    } catch (error) {
      console.error("Cache warm error:", error);
      return c.json({ error: "Failed to warm cache" }, 500);
    }
  }
);

// ──────────────────────────────────────────────────────────────
// Clear Cache Pattern
// ──────────────────────────────────────────────────────────────

optimizationRoutes.delete(
  "/v1/cache/clear",
  rateLimitMiddleware(RateLimits.mutation),
  zValidator(
    "json",
    z.object({
      pattern: z.string().optional(), // e.g., "project:123:*"
      clear_all: z.boolean().optional().default(false),
    })
  ),
  async (c) => {
    const auth = c.get("auth");
    const body = c.req.valid("json");

    try {
      if (body.clear_all) {
        // Only allow admins to clear all cache
        if (!auth.isAdmin) {
          return c.json({ error: "Forbidden: Admin role required" }, 403);
        }
      }

      const pattern = body.clear_all ? "*" : body.pattern || `org:${auth.orgId}:*`;

      const keysCleared = await clearCacheByPattern(pattern);

      return c.json({
        success: true,
        keys_cleared: keysCleared,
      });
    } catch (error) {
      console.error("Clear cache error:", error);
      return c.json({ error: "Failed to clear cache" }, 500);
    }
  }
);

// ──────────────────────────────────────────────────────────────
// Cost Summary - Get cost tracking overview
// ──────────────────────────────────────────────────────────────

optimizationRoutes.get(
  "/v1/cost/summary",
  rateLimitMiddleware(RateLimits.query),
  zValidator(
    "query",
    z.object({
      project: z.string().optional(),
      start_date: z.string().datetime().optional(),
      end_date: z.string().datetime().optional(),
    })
  ),
  async (c) => {
    const auth = c.get("auth");
    const query = c.req.valid("query");

    try {
      let projectId: string | undefined;

      if (query.project) {
        const project = await resolveProjectReference(auth.orgId, query.project, auth.isAdmin);

        if (!project) {
          return c.json({ error: "Project not found" }, 404);
        }

        projectId = project.id;
      }

      const summary = await getCostSummary({
        orgId: auth.orgId,
        projectId,
        startDate: query.start_date ? new Date(query.start_date) : undefined,
        endDate: query.end_date ? new Date(query.end_date) : undefined,
      });

      return c.json({
        org_id: auth.orgId,
        project_id: projectId,
        period: {
          start: summary.period.start.toISOString(),
          end: summary.period.end.toISOString(),
        },
        total_cost_usd: summary.totalCost,
        total_requests: summary.totalRequests,
        cost_by_model: summary.costByModel,
        cost_by_task: summary.costByTask,
        average_cost_per_request: summary.avgCostPerRequest,
        estimated_monthly_cost: summary.estimatedMonthlyCost,
      });
    } catch (error) {
      console.error("Get cost summary error:", error);
      return c.json({ error: "Failed to get cost summary" }, 500);
    }
  }
);

// ──────────────────────────────────────────────────────────────
// Cost Breakdown - Detailed cost analysis
// ──────────────────────────────────────────────────────────────

optimizationRoutes.get(
  "/v1/cost/breakdown",
  rateLimitMiddleware(RateLimits.query),
  zValidator(
    "query",
    z.object({
      project: z.string().optional(),
      group_by: z.enum(["model", "task", "day", "hour"]).optional().default("task"),
      start_date: z.string().datetime().optional(),
      end_date: z.string().datetime().optional(),
    })
  ),
  async (c) => {
    const auth = c.get("auth");
    const query = c.req.valid("query");

    try {
      let projectId: string | undefined;

      if (query.project) {
        const project = await resolveProjectReference(auth.orgId, query.project, auth.isAdmin);

        if (!project) {
          return c.json({ error: "Project not found" }, 404);
        }

        projectId = project.id;
      }

      const breakdown = await getCostBreakdown({
        orgId: auth.orgId,
        projectId,
        groupBy: query.group_by,
        startDate: query.start_date ? new Date(query.start_date) : undefined,
        endDate: query.end_date ? new Date(query.end_date) : undefined,
      });

      return c.json({
        group_by: query.group_by,
        breakdown: breakdown.groups,
        total_cost: breakdown.totalCost,
        total_requests: breakdown.totalRequests,
      });
    } catch (error) {
      console.error("Get cost breakdown error:", error);
      return c.json({ error: "Failed to get cost breakdown" }, 500);
    }
  }
);

// ──────────────────────────────────────────────────────────────
// Savings Report - Compare actual vs always-Opus costs
// ──────────────────────────────────────────────────────────────

optimizationRoutes.get(
  "/v1/cost/savings",
  rateLimitMiddleware(RateLimits.query),
  zValidator(
    "query",
    z.object({
      project: z.string().optional(),
      start_date: z.string().datetime().optional(),
      end_date: z.string().datetime().optional(),
    })
  ),
  async (c) => {
    const auth = c.get("auth");
    const query = c.req.valid("query");

    try {
      let projectId: string | undefined;

      if (query.project) {
        const project = await resolveProjectReference(auth.orgId, query.project, auth.isAdmin);

        if (!project) {
          return c.json({ error: "Project not found" }, 404);
        }

        projectId = project.id;
      }

      const report = await getSavingsReport({
        orgId: auth.orgId,
        projectId,
        startDate: query.start_date ? new Date(query.start_date) : undefined,
        endDate: query.end_date ? new Date(query.end_date) : undefined,
      });

      return c.json({
        period: {
          start: report.period.start.toISOString(),
          end: report.period.end.toISOString(),
        },
        actual_cost_usd: report.actualCost,
        opus_only_cost_usd: report.opusOnlyCost,
        savings_usd: report.savings,
        savings_percentage: report.savingsPercentage,
        requests: {
          total: report.requests.total,
          haiku: report.requests.haiku,
          sonnet: report.requests.sonnet,
          opus: report.requests.opus,
        },
        recommendation: report.recommendation,
      });
    } catch (error) {
      console.error("Get savings report error:", error);
      return c.json({ error: "Failed to get savings report" }, 500);
    }
  }
);
