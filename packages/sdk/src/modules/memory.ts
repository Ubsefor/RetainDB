import { RuntimeClient, RuntimeClientError } from "../core/client.js";
import { SearchResponseCache } from "../core/cache.js";
import type { WriteQueue } from "../core/queue.js";
import type { MemoryScopeTarget, MemorySearchResponse, MemoryWriteAck, MemoryKind, PromotionMode } from "./types.js";

function isEndpointNotFound(error: unknown): boolean {
  return error instanceof RuntimeClientError && error.status === 404;
}

function toSotaType(memoryType?: MemoryKind): MemoryKind | undefined {
  if (!memoryType) return undefined;
  switch (memoryType) {
    case "episodic":
      return "event";
    case "semantic":
      return "factual";
    case "procedural":
      return "instruction";
    default:
      return memoryType;
  }
}

function toLegacyType(memoryType?: MemoryKind): "factual" | "episodic" | "semantic" | "procedural" | undefined {
  if (!memoryType) return undefined;
  switch (memoryType) {
    case "event":
      return "episodic";
    case "instruction":
      return "procedural";
    case "preference":
    case "relationship":
    case "opinion":
    case "goal":
      return "semantic";
    default:
      return memoryType as "factual" | "episodic" | "semantic" | "procedural";
  }
}

export interface MemoryModuleOptions {
  defaultProject?: string;
  cacheEnabled?: boolean;
  queueEnabled?: boolean;
}

export class MemoryModule {
  constructor(
    private readonly client: RuntimeClient,
    private readonly cache: SearchResponseCache<MemorySearchResponse>,
    private readonly queue: WriteQueue,
    private readonly options: MemoryModuleOptions = {},
  ) {}

  private resolveProject(project?: string): string {
    const value = project || this.options.defaultProject;
    if (!value) {
      throw new RuntimeClientError({
        code: "MISSING_PROJECT",
        message: "Project is required",
        retryable: false,
      });
    }
    return value;
  }

  private invalidate(project: string, userId?: string, sessionId?: string, agentId?: string, taskId?: string): void {
    if (this.options.cacheEnabled === false) {
      return;
    }
    const scope = this.cache.makeScopeKey(project, userId, sessionId, agentId, taskId);
    this.cache.invalidateScope(scope);
  }

  async add(params: {
    project?: string;
    content: string;
    memory_type?: MemoryKind;
    user_id?: string;
    session_id?: string;
    agent_id?: string;
    task_id?: string;
    scope_target?: MemoryScopeTarget;
    promotion_mode?: PromotionMode;
    importance?: number;
    confidence?: number;
    metadata?: Record<string, unknown>;
    document_date?: string;
    event_date?: string;
    write_mode?: "async" | "sync";
    async?: boolean;
  }): Promise<MemoryWriteAck> {
    const project = this.resolveProject(params.project);
    const queueEnabled = this.options.queueEnabled !== false;
    const useQueue = queueEnabled && (params.write_mode === "async" || params.async === true);

    if (useQueue) {
      const queued = await this.queue.enqueue({
        project,
        userId: params.user_id,
        sessionId: params.session_id,
        payload: {
          content: params.content,
          memory_type: toSotaType(params.memory_type),
          user_id: params.user_id,
          session_id: params.session_id,
          agent_id: params.agent_id,
          task_id: params.task_id,
          importance: params.importance,
          confidence: params.confidence,
          metadata: {
            ...(params.metadata || {}),
            scope_target: params.scope_target,
            promotion_mode: params.promotion_mode,
          },
          document_date: params.document_date,
          event_date: params.event_date,
        },
      });
      this.invalidate(project, params.user_id, params.session_id, params.agent_id, params.task_id);
      return {
        success: true,
        mode: "async",
        queued: true,
        event_id: queued.eventId,
        accepted_at: queued.createdAt,
      };
    }

    try {
      const response = await this.client.request<Record<string, unknown>>({
        endpoint: "/v1/memory",
        method: "POST",
        operation: "writeAck",
        body: {
          project,
          content: params.content,
          memory_type: toSotaType(params.memory_type),
          user_id: params.user_id,
          session_id: params.session_id,
          agent_id: params.agent_id,
          task_id: params.task_id,
          scope_target: params.scope_target,
          promotion_mode: params.promotion_mode,
          importance: params.importance,
          confidence: params.confidence,
          metadata: params.metadata,
          document_date: params.document_date,
          event_date: params.event_date,
          write_mode: params.write_mode === "async" || params.async === true ? "async" : "sync",
        },
      });
      this.invalidate(project, params.user_id, params.session_id, params.agent_id, params.task_id);
      return {
        success: true,
        mode: "sync",
        trace_id: (response as any).trace_id || (response as any).traceId,
        memory_id: (response as any).memory_id || (response as any).memory?.id,
        semantic_status: (response as any).semantic_status || (response as any).memory?.semantic_status,
        pending_visibility: Boolean((response as any).pending_visibility),
        visibility_sla_ms: (response as any).visibility_sla_ms as number | undefined,
      };
    } catch (error) {
      if (this.client.getCompatMode() !== "fallback" || !isEndpointNotFound(error)) {
        throw error;
      }

      await this.client.request<Record<string, unknown>>({
        endpoint: "/v1/memories",
        method: "POST",
        operation: "writeAck",
        body: {
          project,
          content: params.content,
          memory_type: toLegacyType(params.memory_type),
          user_id: params.user_id,
          session_id: params.session_id,
          agent_id: params.agent_id,
          task_id: params.task_id,
          importance: params.importance,
          metadata: {
            ...(params.metadata || {}),
            scope_target: params.scope_target,
            promotion_mode: params.promotion_mode,
          },
        },
      });
      this.invalidate(project, params.user_id, params.session_id, params.agent_id, params.task_id);
      return {
        success: true,
        mode: "sync",
      };
    }
  }

  async addBulk(params: {
    project?: string;
    memories: Array<{
      content: string;
      memory_type?: MemoryKind;
      user_id?: string;
      session_id?: string;
      agent_id?: string;
      task_id?: string;
      scope_target?: MemoryScopeTarget;
      importance?: number;
      confidence?: number;
      metadata?: Record<string, unknown>;
      document_date?: string;
      event_date?: string;
    }>;
    promotion_mode?: PromotionMode;
    write_mode?: "async" | "sync";
    async?: boolean;
  }): Promise<MemoryWriteAck> {
    const project = this.resolveProject(params.project);
    if (!Array.isArray(params.memories) || params.memories.length === 0) {
      throw new RuntimeClientError({
        code: "VALIDATION_ERROR",
        message: "memories is required",
        retryable: false,
      });
    }

    const queueEnabled = this.options.queueEnabled !== false;
    const useQueue = queueEnabled && (params.write_mode === "async" || params.async === true);
    if (useQueue) {
      const queued = await Promise.all(
        params.memories.map((memory) =>
          this.queue.enqueue({
            project,
            userId: memory.user_id,
            sessionId: memory.session_id,
            payload: {
              content: memory.content,
              memory_type: toSotaType(memory.memory_type),
              user_id: memory.user_id,
              session_id: memory.session_id,
              agent_id: memory.agent_id,
              task_id: memory.task_id,
              importance: memory.importance,
              confidence: memory.confidence,
              metadata: {
                ...(memory.metadata || {}),
                scope_target: memory.scope_target,
                promotion_mode: params.promotion_mode,
              },
              document_date: memory.document_date,
              event_date: memory.event_date,
            },
          })
        )
      );
      for (const memory of params.memories) {
        this.invalidate(project, memory.user_id, memory.session_id, memory.agent_id, memory.task_id);
      }
      return {
        success: true,
        mode: "async",
        queued: true,
        created: queued.length,
      };
    }

    try {
      const response = await this.client.request<Record<string, unknown>>({
        endpoint: "/v1/memory/bulk",
        method: "POST",
        operation: "bulk",
        body: {
          project,
          memories: params.memories.map((memory) => ({
            ...memory,
            memory_type: toSotaType(memory.memory_type),
          })),
          promotion_mode: params.promotion_mode,
          write_mode: params.write_mode === "async" || params.async === true ? "async" : "sync",
        },
      });
      for (const memory of params.memories) {
        this.invalidate(project, memory.user_id, memory.session_id, memory.agent_id, memory.task_id);
      }
      return {
        success: true,
        mode: "sync",
        trace_id: response.traceId,
      };
    } catch (error) {
      if (this.client.getCompatMode() !== "fallback" || !isEndpointNotFound(error)) {
        throw error;
      }

      await Promise.all(
        params.memories.map((memory) =>
          this.add({
            project,
            ...memory,
            promotion_mode: params.promotion_mode,
            write_mode: "sync",
          })
        )
      );
      return {
        success: true,
        mode: "sync",
      };
    }
  }

  async search(params: {
    project?: string;
    query: string;
    user_id?: string;
    session_id?: string;
    agent_id?: string;
    task_id?: string;
    top_k?: number;
    memory_type?: MemoryKind;
    scope_targets?: MemoryScopeTarget[];
    profile?: "fast" | "balanced" | "quality";
    include_pending?: boolean;
  }): Promise<MemorySearchResponse> {
    const project = this.resolveProject(params.project);
    const topK = params.top_k || 10;
    const profile = params.profile || "fast";
    const includePending = params.include_pending !== false;

    const cacheKey = this.cache.makeKey({
      project,
      userId: params.user_id,
      sessionId: params.session_id,
      agentId: params.agent_id,
      taskId: params.task_id,
      query: params.query,
      topK,
      profile,
      includePending,
    });
    if (this.options.cacheEnabled !== false) {
      const cached = this.cache.get(cacheKey);
      if (cached) {
        return {
          ...cached,
          cache_hit: true,
        };
      }
    }

    try {
      const response = await this.client.request<MemorySearchResponse>({
        endpoint: "/v1/memory/search",
        method: "POST",
        operation: "search",
        idempotent: true,
        body: {
          project,
          query: params.query,
          user_id: params.user_id,
          session_id: params.session_id,
          agent_id: params.agent_id,
          task_id: params.task_id,
          top_k: topK,
          profile,
          include_pending: includePending,
          scope_targets: params.scope_targets,
          memory_types: params.memory_type ? [toSotaType(params.memory_type)] : undefined,
        },
      });
      const data: MemorySearchResponse = {
        ...(response.data || ({} as MemorySearchResponse)),
        cache_hit: false,
      };
      if (this.options.cacheEnabled !== false) {
        const scope = this.cache.makeScopeKey(project, params.user_id, params.session_id, params.agent_id, params.task_id);
        this.cache.set(cacheKey, scope, data);
      }
      return data;
    } catch (error) {
      if (this.client.getCompatMode() !== "fallback" || !isEndpointNotFound(error)) {
        throw error;
      }

      const legacy = await this.client.request<MemorySearchResponse>({
        endpoint: "/v1/memories/search",
        method: "POST",
        operation: "search",
        idempotent: true,
        body: {
          project,
          query: params.query,
          user_id: params.user_id,
          session_id: params.session_id,
          agent_id: params.agent_id,
          task_id: params.task_id,
          top_k: topK,
          memory_type: toLegacyType(params.memory_type),
        },
      });
      const data = {
        ...(legacy.data || ({} as MemorySearchResponse)),
        cache_hit: false,
      };
      if (this.options.cacheEnabled !== false) {
        const scope = this.cache.makeScopeKey(project, params.user_id, params.session_id, params.agent_id, params.task_id);
        this.cache.set(cacheKey, scope, data);
      }
      return data;
    }
  }

  async getUserProfile(params: {
    project?: string;
    user_id: string;
    include_pending?: boolean;
    memory_types?: string;
  }): Promise<{ user_id: string; memories: Array<Record<string, unknown>>; count: number }> {
    const project = this.resolveProject(params.project);
    const query = new URLSearchParams({
      project,
      ...(params.include_pending !== undefined ? { include_pending: String(params.include_pending) } : {}),
      ...(params.memory_types ? { memory_types: params.memory_types } : {}),
    });
    try {
      const response = await this.client.request<{ user_id: string; memories: Array<Record<string, unknown>>; count: number }>({
        endpoint: `/v1/memory/profile/${params.user_id}?${query}`,
        method: "GET",
        operation: "profile",
        idempotent: true,
      });
      return response.data;
    } catch (error) {
      if (this.client.getCompatMode() !== "fallback" || !isEndpointNotFound(error)) {
        throw error;
      }
      const legacyQuery = new URLSearchParams({
        project,
        user_id: params.user_id,
        limit: "200",
      });
      const legacy = await this.client.request<{ memories?: Array<Record<string, unknown>> }>({
        endpoint: `/v1/memories?${legacyQuery}`,
        method: "GET",
        operation: "profile",
        idempotent: true,
      });
      const memories = Array.isArray(legacy.data?.memories) ? legacy.data.memories : [];
      return {
        user_id: params.user_id,
        memories,
        count: memories.length,
      };
    }
  }

  async getSessionMemories(params: {
    project?: string;
    session_id: string;
    include_pending?: boolean;
    limit?: number;
  }): Promise<{ memories: Array<Record<string, unknown>>; count: number }> {
    const project = this.resolveProject(params.project);
    const query = new URLSearchParams({
      project,
      ...(params.limit ? { limit: String(params.limit) } : {}),
      ...(params.include_pending !== undefined ? { include_pending: String(params.include_pending) } : {}),
    });
    const response = await this.client.request<{ memories: Array<Record<string, unknown>>; count: number }>({
      endpoint: `/v1/memory/session/${params.session_id}?${query}`,
      method: "GET",
      operation: "profile",
      idempotent: true,
    });
    return response.data;
  }

  async get(memoryId: string): Promise<{ memory: Record<string, unknown> }> {
    try {
      const response = await this.client.request<{ memory: Record<string, unknown> }>({
        endpoint: `/v1/memory/${memoryId}`,
        method: "GET",
        operation: "get",
        idempotent: true,
      });
      return response.data;
    } catch (error) {
      if (this.client.getCompatMode() !== "fallback" || !isEndpointNotFound(error)) {
        throw error;
      }
      const legacy = await this.client.request<{ memory: Record<string, unknown> }>({
        endpoint: `/v1/memories/${memoryId}`,
        method: "GET",
        operation: "get",
        idempotent: true,
      });
      return legacy.data;
    }
  }

  async update(memoryId: string, params: { content: string; reasoning?: string }): Promise<{ success: boolean }> {
    try {
      await this.client.request<Record<string, unknown>>({
        endpoint: `/v1/memory/${memoryId}`,
        method: "PUT",
        operation: "writeAck",
        body: params,
      });
      return { success: true };
    } catch (error) {
      if (this.client.getCompatMode() !== "fallback" || !isEndpointNotFound(error)) {
        throw error;
      }
      await this.client.request<Record<string, unknown>>({
        endpoint: `/v1/memories/${memoryId}`,
        method: "PUT",
        operation: "writeAck",
        body: { content: params.content },
      });
      return { success: true };
    }
  }

  async delete(memoryId: string): Promise<{ success: boolean; deleted: string }> {
    try {
      await this.client.request<Record<string, unknown>>({
        endpoint: `/v1/memory/${memoryId}`,
        method: "DELETE",
        operation: "writeAck",
      });
      return { success: true, deleted: memoryId };
    } catch (error) {
      if (this.client.getCompatMode() !== "fallback" || !isEndpointNotFound(error)) {
        throw error;
      }
      await this.client.request<Record<string, unknown>>({
        endpoint: `/v1/memories/${memoryId}`,
        method: "DELETE",
        operation: "writeAck",
      });
      return { success: true, deleted: memoryId };
    }
  }

  async flag(params: { memoryId: string; reason: string; severity?: "low" | "medium" | "high" }): Promise<{ success: boolean }> {
    try {
      await this.client.request<Record<string, unknown>>({
        endpoint: `/v1/memory/${params.memoryId}/flag`,
        method: "POST",
        operation: "writeAck",
        body: {
          reason: params.reason,
          severity: params.severity || "medium",
        },
      });
      return { success: true };
    } catch (error) {
      if (this.client.getCompatMode() !== "fallback" || !isEndpointNotFound(error)) {
        throw error;
      }
      await this.client.request<Record<string, unknown>>({
        endpoint: `/v1/memory/${params.memoryId}`,
        method: "PUT",
        operation: "writeAck",
        body: {
          content: `[FLAGGED:${params.severity || "medium"}] ${params.reason}`,
        },
      });
      return { success: true };
    }
  }
}
