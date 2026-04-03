/**
 * Context Layer API Routes
 * Endpoints for Oracle search, Autosubscribe, and Context Sharing
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { prisma } from "../db/index.js";
import type { AuthContext } from "../middleware/auth.js";
import { rateLimitMiddleware, RateLimits } from "../middleware/rate-limit.js";

import { oracleSearch, oracleResearch } from "../engine/oracle.js";
import {
  createSharedContext,
  loadSharedContext,
  resumeFromSharedContext,
} from "../engine/context-sharing.js";
import { ensureProject } from "./helpers.js";

type Variables = {
  auth: AuthContext;
};

export const contextRoutes = new Hono<{ Variables: Variables }>();

// ──────────────────────────────────────────────────────────────
// Oracle Search - Tree-guided document navigation
// ──────────────────────────────────────────────────────────────

contextRoutes.post(
  "/v1/oracle/search",
  rateLimitMiddleware(RateLimits.query),
  zValidator(
    "json",
    z.object({
      query: z.string().min(1).max(5000),
      project: z.string().optional(),
      max_results: z.number().int().min(1).max(20).optional().default(5),
      mode: z.enum(["search", "research"]).optional().default("search"),
      max_steps: z.number().int().min(1).max(10).optional().default(5),
    })
  ),
  async (c) => {
    const auth = c.get("auth");
    const body = c.req.valid("json");
    const startTime = Date.now();

    try {
      const project = await ensureProject(auth.orgId, body.project, auth.isAdmin);

      let result;

      if (body.mode === "research") {
        // Multi-step research mode
        result = await oracleResearch({
          question: body.query,
          projectId: project.id,
          maxSteps: body.max_steps,
        });


        return c.json({
          mode: "research",
          query: body.query,
          answer: result.answer,
          steps: result.steps,
          sources: (result as any).sources ?? [],
          latency_ms: Date.now() - startTime,
        });
      } else {
        // Simple tree-guided search
        const results = await oracleSearch({
          query: body.query,
          projectId: project.id,
          topK: body.max_results,
        });


        return c.json({
          mode: "search",
          query: body.query,
          results: results.map((r) => ({
            content: r.content,
            path: r.path,
            relevance: r.relevance,
            metadata: (r as any).metadata ?? {},
          })),
          count: results.length,
          latency_ms: Date.now() - startTime,
        });
      }
    } catch (error) {
      console.error("Oracle search error:", error);
      return c.json({ error: "Oracle search failed" }, 500);
    }
  }
);

// ──────────────────────────────────────────────────────────────
// Context Sharing - Create shareable context snapshot
// ──────────────────────────────────────────────────────────────

contextRoutes.post(
  "/v1/context/share",
  rateLimitMiddleware(RateLimits.mutation),
  zValidator(
    "json",
    z.object({
      session_id: z.string(),
      project: z.string().optional(),
      title: z.string().optional(),
      include_memories: z.boolean().optional().default(true),
      include_chunks: z.boolean().optional().default(false),
      expiry_days: z.number().int().min(1).max(365).optional().default(30),
    })
  ),
  async (c) => {
    const auth = c.get("auth");
    const body = c.req.valid("json");

    try {
      const project = await ensureProject(auth.orgId, body.project, auth.isAdmin);

      const sharedContext = await createSharedContext({
        sessionId: body.session_id,
        projectId: project.id,
        orgId: auth.orgId,
        title: body.title,
        includeMemories: body.include_memories,
        includeChunks: body.include_chunks,
        expiryDays: body.expiry_days,
      });

      const baseUrl = process.env.BASE_URL || "https://api.retaindb.com";
      const shareUrl = `${baseUrl}/shared/${sharedContext.id}`;

      return c.json({
        success: true,
        share_id: sharedContext.id,
        share_url: shareUrl,
        title: sharedContext.title,
        memories_count: sharedContext.memories.length,
        messages_count: sharedContext.messages.length,
        expires_at: sharedContext.expiresAt?.toISOString() || null,
      });
    } catch (error) {
      console.error("Create shared context error:", error);
      return c.json({ error: "Failed to create shared context" }, 500);
    }
  }
);

// ──────────────────────────────────────────────────────────────
// Load Shared Context - View shared context (public)
// ──────────────────────────────────────────────────────────────

contextRoutes.get(
  "/v1/context/shared/:shareId",
  rateLimitMiddleware(RateLimits.query),
  async (c) => {
    const shareId = c.req.param("shareId") ?? "";

    try {
      const sharedContext = await loadSharedContext(shareId);

      if (!sharedContext) {
        return c.json({ error: "Shared context not found or expired" }, 404);
      }

      return c.json({
        share_id: sharedContext.id,
        title: sharedContext.title,
        created_at: sharedContext.createdAt.toISOString(),
        expires_at: sharedContext.expiresAt?.toISOString() || null,
        memories: sharedContext.memories,
        messages: sharedContext.messages,
        chunks: sharedContext.chunks,
        metadata: sharedContext.metadata,
      });
    } catch (error) {
      console.error("Load shared context error:", error);
      return c.json({ error: "Failed to load shared context" }, 500);
    }
  }
);

// ──────────────────────────────────────────────────────────────
// Resume from Shared Context - Fork shared context to new session
// ──────────────────────────────────────────────────────────────

contextRoutes.post(
  "/v1/context/resume",
  rateLimitMiddleware(RateLimits.mutation),
  zValidator(
    "json",
    z.object({
      share_id: z.string(),
      project: z.string().optional(),
      new_session_id: z.string().optional(),
    })
  ),
  async (c) => {
    const auth = c.get("auth");
    const body = c.req.valid("json");

    try {
      const project = await ensureProject(auth.orgId, body.project, auth.isAdmin);

      const result = await resumeFromSharedContext({
        shareId: body.share_id,
        projectId: project.id,
        orgId: auth.orgId,
        newSessionId: body.new_session_id,
      });

      return c.json({
        success: true,
        session_id: result.sessionId,
        memories_restored: result.memoriesRestored,
        messages_restored: result.messagesRestored,
        chunks_restored: result.chunksRestored,
      });
    } catch (error) {
      console.error("Resume from shared context error:", error);
      return c.json({ error: "Failed to resume from shared context" }, 500);
    }
  }
);

