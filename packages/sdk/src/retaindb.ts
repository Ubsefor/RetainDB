/**
 * RetainDB - simple, fluent SDK
 *
 * const db = new RetainDB({ apiKey: process.env.RETAINDB_KEY });
 *
 * // Manual
 * const { context } = await db.user(userId).getContext(query);
 * const reply = await llm.chat({ system: context });
 * await db.user(userId).remember(userMessage);
 *
 * // Automatic (retrieve -> generate -> store)
 * const turn = await db.user(userId).runTurn({
 *   messages,
 *   waitForMemoryWrite: true,
 *   generate: (ctx) => llm.chat(ctx),
 * });
 * console.log(turn.response);
 * console.log(turn.writeStatus);
 */
import { RuntimeClient } from "./core/client.js";
import { SearchResponseCache } from "./core/cache.js";
import { WriteQueue } from "./core/queue.js";
import { DiagnosticsStore } from "./core/telemetry.js";
import { MemoryModule } from "./modules/memory.js";
import { FilesModule } from "./modules/files.js";
import type { LearnInput, LearnResult, MemorySearchResponse } from "./modules/types.js";

export interface RetainDBOptions {
  /** API key — falls back to RETAINDB_KEY then RETAINDB_API_KEY env vars */
  apiKey?: string;
  /** Base URL — defaults to https://api.retaindb.com */
  baseUrl?: string;
  /** Project slug or id — falls back to RETAINDB_PROJECT env var; auto-creates "default" if absent */
  project?: string;
}

export type Message = { role: "user" | "assistant" | "system"; content: string };

export interface TurnContext {
  /** Formatted context string — inject into your LLM's system prompt */
  context: string;
  /** The original messages array with context injected as a leading system message */
  messages: Message[];
}

export type MemoryType =
  | "factual"
  | "preference"
  | "event"
  | "goal"
  | "instruction"
  | "relationship"
  | "opinion";

export interface MemoryItem {
  id: string;
  content: string;
  type: MemoryType | string; // string fallback for unknown server-side types
}

export interface TurnResult<R = unknown> {
  response: R;
  context: string;
  writeStatus: "pending" | "confirmed" | "failed";
  memorySummary?: {
    count: number;
    recent: MemoryItem[];
  };
  error?: string;
}

export interface RunTurnOptions<R = unknown> {
  messages: Message[];
  generate: (ctx: TurnContext) => Promise<R>;
  sessionId?: string;
  preContext?: string;
  onWriteError?: (err: Error) => void;
  waitForMemoryWrite?: boolean;
  writeTimeoutMs?: number;
}

export interface UserScope {
  /** Retrieve relevant memories as a formatted context string */
  getContext(query: string): Promise<{ context: string; raw: MemorySearchResponse }>;
  /** Search memories by query — returns matching MemoryItems */
  searchMemory(query: string): Promise<MemoryItem[]>;
  /** List all stored memories for this user */
  listMemory(): Promise<MemoryItem[]>;
  /** Store a memory string, or dump an entire conversation for automatic extraction */
  remember(content: string | Message[]): Promise<void>;
  /** Forget (delete) a memory by id */
  forget(memoryId: string): Promise<void>;
  /** Scope to a specific session */
  session(sessionId: string): SessionScope;
  /** Retrieve + generate + store in one call.
   *
   *  Options:
   *  - `preContext`    — skip retrieval, use this string instead (prefetch while user types)
   *  - `onWriteError` — called if the background memory write fails (default: silent)
   *
   *  Streaming: runTurn is not streaming-compatible. For streaming, use:
   *    const { context } = await user.getContext(query);
   *    const stream = llm.stream({ messages: injectContext(messages, context) });
   *    await user.remember(userMessage); // after stream completes
   */
  runTurn<R>(opts: RunTurnOptions<R>): Promise<TurnResult<R>>;
}

export interface SessionScope {
  /** Retrieve relevant memories for this session as context */
  getContext(query: string): Promise<{ context: string; raw: MemorySearchResponse }>;
  /** Search memories by query for this session */
  searchMemory(query: string): Promise<MemoryItem[]>;
  /** List all stored memories for this session */
  listMemory(): Promise<MemoryItem[]>;
  /** Store a memory or dump a conversation for this session */
  remember(content: string | Message[]): Promise<void>;
  /** Retrieve + generate + store in one call, scoped to this session.
   *
   *  Options:
   *  - `preContext`    — skip retrieval, use this string instead (prefetch while user types)
   *  - `onWriteError` — called if the background memory write fails (default: silent)
   *
   *  Streaming: runTurn is not streaming-compatible. For streaming, use:
   *    const { context } = await user.getContext(query);
   *    const stream = llm.stream({ messages: injectContext(messages, context) });
   *    await user.remember(userMessage); // after stream completes
   */
  runTurn<R>(opts: RunTurnOptions<R>): Promise<TurnResult<R>>;
}

export interface SessionLearnScope {
  learn(params: LearnInput): Promise<LearnResult>;
  user(userId: string): {
    learn(params: LearnInput): Promise<LearnResult>;
  };
}

export type AgentWorkEvent = {
  kind: "decision" | "constraint" | "outcome" | "failure" | "task_update" | "file_edit" | "tool_result";
  summary: string;
  details?: string;
  salience?: "low" | "medium" | "high";
  timestamp?: string;
  filePaths?: string[];
  toolName?: string;
  success?: boolean;
};

export interface AgentScope {
  task(taskId: string): AgentScope;
  context(query: string, opts?: { sessionId?: string; userId?: string; topK?: number }): Promise<{ context: string; raw: MemorySearchResponse }>;
  recall(query: string, opts?: { sessionId?: string; userId?: string; topK?: number }): Promise<MemoryItem[]>;
  event(event: AgentWorkEvent, opts?: { sessionId?: string; userId?: string; taskId?: string }): Promise<void>;
  remember(content: string, opts?: { sessionId?: string; userId?: string; taskId?: string }): Promise<void>;
  handoff(opts: { sessionId: string; title?: string; expiryDays?: number }): Promise<{ shareId: string; shareUrl?: string }>;
}

export class RetainDB {
  private readonly memory: MemoryModule;
  readonly files: FilesModule;
  private readonly queue: WriteQueue;
  private readonly project: string | undefined;
  private readonly _client: RuntimeClient;

  constructor(opts: RetainDBOptions = {}) {
    const apiKey =
      opts.apiKey ||
      (typeof process !== "undefined" && (process.env.RETAINDB_KEY || process.env.RETAINDB_API_KEY)) ||
      "";

    const project =
      opts.project ||
      (typeof process !== "undefined" && process.env.RETAINDB_PROJECT) ||
      undefined;

    this.project = project;

    const diagnostics = new DiagnosticsStore(200);
    const client = new RuntimeClient(
      {
        apiKey,
        baseUrl: opts.baseUrl,
        sdkVersion: "4.x-retaindb",
      },
      diagnostics
    );

    this.queue = new WriteQueue({
      maxAttempts: 2,
      flushHandler: async (items) => {
        if (items.length === 0) return;
        const memories = items.map((item) => ({
          ...item.payload,
          user_id: item.payload.user_id ?? item.userId,
          session_id: item.payload.session_id ?? item.sessionId,
          metadata: {
            ...(item.payload.metadata || {}),
            event_id: item.eventId,
            queued_at: item.createdAt,
          },
        }));
        await client.request({
          endpoint: "/v1/memory/bulk",
          method: "POST",
          operation: "bulk",
          body: {
            project: items[0].project,
            write_mode: "async",
            memories,
          },
        });
      },
    });

    this._client = client;

    // SearchResponseCache(ttlMs, capacity)
    const cache = new SearchResponseCache<MemorySearchResponse>(30_000, 100);
    this.memory = new MemoryModule(client, cache, this.queue, {
      defaultProject: project,
    });
    this.files = new FilesModule(client, project);

    // Auto-drain the write queue when the Node.js process exits normally
    if (typeof process !== "undefined" && typeof process.on === "function") {
      process.on("beforeExit", () => {
        this.queue.flush().catch(() => {});
      });
    }
  }

  /** Create a user-scoped helper */
  user(userId: string): UserScope {
    if (!userId || !userId.trim()) throw new Error("RetainDB: userId is required and cannot be empty");
    const memory = this.memory;
    const project = this.project;

    const getContext = async (
      query: string,
    ): Promise<{ context: string; raw: MemorySearchResponse }> => {
      const raw = await memory.search({
        project,
        user_id: userId,
        query,
        top_k: 10,
        include_pending: true,
        profile: "fast",
      });
      const context = formatContext(raw);
      return { context, raw };
    };

    const remember = async (content: string | Message[]): Promise<void> => {
      if (typeof content === "string") {
        if (!content.trim()) return;
        await memory.add({ project, user_id: userId, content });
        return;
      }
      // Conversation import — only user messages contain user data worth storing.
      // Assistant messages are generated from stored memories, not new information.
      const memories = content
        .filter((m) => m.role === "user" && m.content.trim())
        .map((m) => ({ content: m.content, user_id: userId }));
      if (memories.length > 0) {
        await memory.addBulk({ project, memories });
      }
    };

    const searchMemory = async (query: string): Promise<MemoryItem[]> => {
      const raw = await memory.search({
        project,
        user_id: userId,
        query,
        top_k: 15,
        include_pending: true,
        profile: "fast",
      });
      return extractMemoryItems(raw);
    };

    const listMemory = async (): Promise<MemoryItem[]> => {
      const raw = await memory.getUserProfile({
        project,
        user_id: userId,
        include_pending: true,
      });
      return (raw.memories ?? [])
        .map((r: any) => ({
          id: String(r?.id ?? ""),
          content: String(r?.content ?? ""),
          type: String(r?.memory_type ?? r?.type ?? "factual"),
        }))
        .filter((m) => m.content);
    };

    const forget = async (memoryId: string): Promise<void> => {
      await memory.delete(memoryId);
    };

    const session = (sessionId: string): SessionScope => {
      if (!sessionId || !sessionId.trim()) throw new Error("RetainDB: sessionId is required and cannot be empty");
      const sessionGetContext = async (
        query: string,
      ): Promise<{ context: string; raw: MemorySearchResponse }> => {
        const raw = await memory.search({
          project,
          user_id: userId,
          session_id: sessionId,
          query,
          top_k: 10,
          include_pending: true,
          profile: "fast",
        });
        const context = formatContext(raw);
        return { context, raw };
      };

      const sessionListMemory = async (): Promise<MemoryItem[]> => {
        const raw = await memory.getSessionMemories({
          project,
          session_id: sessionId,
          include_pending: true,
          limit: 100,
        });
        return (raw.memories ?? [])
          .map((r: any) => ({
            id: String(r?.id ?? ""),
            content: String(r?.content ?? ""),
            type: String(r?.memory_type ?? r?.type ?? "factual"),
          }))
          .filter((m) => m.content);
      };

      const sessionSearchMemory = async (query: string): Promise<MemoryItem[]> => {
        const raw = await memory.search({
          project,
          user_id: userId,
          session_id: sessionId,
          query,
          top_k: 15,
          include_pending: true,
          profile: "fast",
        });
        return extractMemoryItems(raw);
      };

      const sessionRemember = async (content: string | Message[]): Promise<void> => {
        if (typeof content === "string") {
          if (!content.trim()) return;
          await memory.add({ project, user_id: userId, session_id: sessionId, content });
          return;
        }
        const memories = content
          .filter((m) => m.role === "user" && m.content.trim())
          .map((m) => ({ content: m.content, user_id: userId, session_id: sessionId }));
        if (memories.length > 0) {
          await memory.addBulk({ project, memories });
        }
      };

      const sessionRunTurn = async <R>(opts: RunTurnOptions<R>): Promise<TurnResult<R>> => {
        const lastUserMessage = findLastUserMessage(opts.messages);
        let context: string;
        if (opts.preContext !== undefined) {
          context = opts.preContext;
        } else {
          const retrievalQuery = buildRetrievalQuery(opts.messages);
          ({ context } = await sessionGetContext(retrievalQuery));
        }
        const enriched = buildTurnContext(opts.messages, context);
        const response = await opts.generate(enriched);

        const result: TurnResult<R> = {
          response,
          context,
          writeStatus: "pending",
        };

        if (!lastUserMessage) {
          result.writeStatus = "confirmed";
          return result;
        }

        const writeTimeoutMs = Math.max(1000, opts.writeTimeoutMs ?? 5000);
        const writeTask = async (): Promise<TurnResult<R>["memorySummary"] | undefined> => {
          await sessionRemember(lastUserMessage);
          try {
            const memories = await sessionListMemory();
            return {
              count: memories.length,
              recent: memories.slice(-5),
            };
          } catch {
            // Best effort: the memory was written, but the summary fetch failed.
          }
          return undefined;
        };

        if (opts.waitForMemoryWrite) {
          try {
            const summary = await withTimeout(writeTask(), writeTimeoutMs, `Memory write timed out after ${writeTimeoutMs}ms`);
            result.writeStatus = "confirmed";
            if (summary) {
              result.memorySummary = summary;
            }
          } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            result.writeStatus = "failed";
            result.error = error.message;
            if (opts.onWriteError) opts.onWriteError(error);
            else console.warn("[RetainDB] runTurn: memory write failed:", error.message);
          }
          return result;
        }

        writeTask().catch((err) => {
          const error = err instanceof Error ? err : new Error(String(err));
          if (opts.onWriteError) opts.onWriteError(error);
          else console.warn("[RetainDB] runTurn: memory write failed:", error.message);
        });

        return result;
      };

      return {
        getContext: sessionGetContext,
        searchMemory: sessionSearchMemory,
        listMemory: sessionListMemory,
        remember: sessionRemember,
        runTurn: sessionRunTurn,
      };
    };

    const runTurn = async <R>(opts: RunTurnOptions<R>): Promise<TurnResult<R>> => {
      if (opts.sessionId) {
        return session(opts.sessionId).runTurn({
          messages: opts.messages,
          generate: opts.generate,
          preContext: opts.preContext,
          onWriteError: opts.onWriteError,
          waitForMemoryWrite: opts.waitForMemoryWrite,
          writeTimeoutMs: opts.writeTimeoutMs,
        });
      }
      const lastUserMessage = findLastUserMessage(opts.messages);
      let context: string;
      if (opts.preContext !== undefined) {
        context = opts.preContext;
      } else {
        const retrievalQuery = buildRetrievalQuery(opts.messages);
        ({ context } = await getContext(retrievalQuery));
      }
      const enriched = buildTurnContext(opts.messages, context);
      const response = await opts.generate(enriched);

      const result: TurnResult<R> = {
        response,
        context,
        writeStatus: "pending",
      };

      if (!lastUserMessage) {
        result.writeStatus = "confirmed";
        return result;
      }

      const writeTimeoutMs = Math.max(1000, opts.writeTimeoutMs ?? 5000);
      const writeTask = async (): Promise<TurnResult<R>["memorySummary"] | undefined> => {
        await remember(lastUserMessage);
        try {
          const memories = await listMemory();
          return {
            count: memories.length,
            recent: memories.slice(-5),
          };
        } catch {
          // Best effort: the memory was written, but the summary fetch failed.
        }
        return undefined;
      };

      if (opts.waitForMemoryWrite) {
        try {
          const summary = await withTimeout(writeTask(), writeTimeoutMs, `Memory write timed out after ${writeTimeoutMs}ms`);
          result.writeStatus = "confirmed";
          if (summary) {
            result.memorySummary = summary;
          }
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          result.writeStatus = "failed";
          result.error = error.message;
          if (opts.onWriteError) opts.onWriteError(error);
          else console.warn("[RetainDB] runTurn: memory write failed:", error.message);
        }
        return result;
      }

      writeTask().catch((err) => {
        const error = err instanceof Error ? err : new Error(String(err));
        if (opts.onWriteError) opts.onWriteError(error);
        else console.warn("[RetainDB] runTurn: memory write failed:", error.message);
      });
      return result;
    };

    return { getContext, searchMemory, listMemory, remember, forget, session, runTurn };
  }

  /** Create an agent-scoped helper for local RetainDB workflows. */
  agent(agentId: string, baseTaskId?: string): AgentScope {
    if (!agentId || !agentId.trim()) throw new Error("RetainDB: agentId is required and cannot be empty");
    const memory = this.memory;
    const project = this.project;
    const currentAgentId = agentId.trim();

    const scopeFor = (taskId?: string): AgentScope => {
      const currentTaskId = taskId || baseTaskId;
      const context = async (
        query: string,
        opts: { sessionId?: string; userId?: string; topK?: number } = {},
      ): Promise<{ context: string; raw: MemorySearchResponse }> => {
        const raw = await memory.search({
          project,
          query,
          top_k: opts.topK ?? 10,
          include_pending: true,
          profile: "balanced",
          user_id: opts.userId,
          session_id: opts.sessionId,
          agent_id: currentAgentId,
          task_id: currentTaskId,
        });
        return { context: formatContext(raw), raw };
      };

      const recall = async (
        query: string,
        opts: { sessionId?: string; userId?: string; topK?: number } = {},
      ): Promise<MemoryItem[]> => {
        const raw = await context(query, opts);
        return extractMemoryItems(raw.raw);
      };

      const remember = async (
        content: string,
        opts: { sessionId?: string; userId?: string; taskId?: string } = {},
      ): Promise<void> => {
        if (!content.trim()) return;
        await memory.add({
          project,
          content,
          memory_type: "factual",
          user_id: opts.userId,
          session_id: opts.sessionId,
          agent_id: currentAgentId,
          task_id: opts.taskId || currentTaskId,
          write_mode: "async",
        });
      };

      const event = async (
        workEvent: AgentWorkEvent,
        opts: { sessionId?: string; userId?: string; taskId?: string } = {},
      ): Promise<void> => {
        const prefix = workEvent.kind.replace(/_/g, " ");
        const details = workEvent.details ? `\n${workEvent.details}` : "";
        await remember(`${prefix}: ${workEvent.summary}${details}`, {
          ...opts,
          taskId: opts.taskId || currentTaskId,
        });
      };

      const handoff = async (opts: { sessionId: string; title?: string; expiryDays?: number }) => {
        const response = await this._client.request<any>({
          endpoint: "/v1/context/share",
          method: "POST",
          operation: "session",
          body: {
            project,
            session_id: opts.sessionId,
            title: opts.title || `Agent handoff: ${currentTaskId || currentAgentId}`,
            include_memories: true,
            include_chunks: false,
            expiry_days: opts.expiryDays ?? 7,
          },
        });
        return {
          shareId: String(response.data?.share_id || ""),
          shareUrl: response.data?.share_url ? String(response.data.share_url) : undefined,
        };
      };

      return {
        task: (nextTaskId: string) => scopeFor(nextTaskId),
        context,
        recall,
        event,
        remember,
        handoff,
      };
    };

    return scopeFor(baseTaskId);
  }

  /**
   * Index a source so your AI can retrieve from it.
   *
   * @example
   * await db.ingest({ type: "url", url: "https://docs.example.com" });
   * await db.ingest({ type: "github", owner: "org", repo: "repo" });
   * await db.ingest({ type: "pdf", url: "https://example.com/file.pdf" });
   */
  async ingest(source: {
    type: string;
    name?: string;
    [key: string]: unknown;
  }): Promise<{ sourceId: string; status: string }> {
    const name = source.name || `${source.type}-${Date.now()}`;
    const res = await this._client.request<{ id?: string; sourceId?: string; status?: string }>({
      endpoint: "/v1/sources",
      method: "POST",
      operation: "createSource",
      body: {
        project: this.project,
        type: source.type,
        name,
        config: source,
      },
    });
    const data = res?.data ?? (res as any);
    return {
      sourceId: String(data?.id ?? data?.sourceId ?? ""),
      status: String(data?.status ?? "created"),
    };
  }

  async learn(params: LearnInput): Promise<LearnResult> {
    const project = params.project || this.project || "default";
    const response = await this._client.request<LearnResult>({
      endpoint: "/v1/learn",
      method: "POST",
      operation: params.mode === "conversation" ? "session" : "bulk",
      body: {
        ...params,
        project,
      },
    });
    return response.data;
  }

  // ── Company brain (sources-aware retrieval) ────────────────────────────

  /** List registered source connectors (web, github, slack, …) with their auth requirements. */
  async getConnectorDescriptors(): Promise<{
    connectors: Array<{ type: string; requiresAuth: boolean; description: string }>;
  }> {
    const response = await this._client.request<{
      connectors: Array<{ type: string; requiresAuth: boolean; description: string }>;
    }>({ endpoint: "/v1/sources/connectors", method: "GET", operation: "list_connectors" });
    return response.data;
  }

  async listSources(): Promise<{ sources: Array<Record<string, unknown>> }> {
    const project = this.project || "default";
    const response = await this._client.request<{ sources: Array<Record<string, unknown>> }>({
      endpoint: `/v1/sources?project=${encodeURIComponent(project)}`,
      method: "GET",
      operation: "list_sources",
    });
    return response.data;
  }

  async getSource(id: string): Promise<Record<string, unknown>> {
    const response = await this._client.request<Record<string, unknown>>({
      endpoint: `/v1/sources/${encodeURIComponent(id)}`,
      method: "GET",
      operation: "get_source",
    });
    return response.data;
  }

  async addSource(input: {
    type: string;
    name?: string;
    project?: string;
    config: Record<string, unknown>;
  }): Promise<Record<string, unknown>> {
    const project = input.project || this.project || "default";
    const response = await this._client.request<Record<string, unknown>>({
      endpoint: "/v1/sources",
      method: "POST",
      operation: "create_source",
      body: { ...input, project },
    });
    return response.data;
  }

  async updateSource(id: string, patch: { name?: string; config?: Record<string, unknown> }): Promise<Record<string, unknown>> {
    const response = await this._client.request<Record<string, unknown>>({
      endpoint: `/v1/sources/${encodeURIComponent(id)}`,
      method: "PATCH",
      operation: "update_source",
      body: patch,
    });
    return response.data;
  }

  async deleteSource(id: string): Promise<{ deleted: boolean; id: string }> {
    const response = await this._client.request<{ deleted: boolean; id: string }>({
      endpoint: `/v1/sources/${encodeURIComponent(id)}`,
      method: "DELETE",
      operation: "delete_source",
    });
    return response.data;
  }

  /** Run sync for a source — fetches remote content, indexes as memories, returns citations. */
  async syncSource(id: string): Promise<{
    source_id: string;
    result: { documents_indexed: number; memories_created: number; errors: string[]; truncated: boolean; duration_ms: number; citations: Array<{ id: string; title: string }> };
    citations: Array<{ id: string; title: string }>;
  }> {
    const response = await this._client.request<{ source_id: string; result: any; citations: Array<{ id: string; title: string }> }>({
      endpoint: `/v1/sources/${encodeURIComponent(id)}/sync`,
      method: "POST",
      operation: "sync_source",
    });
    return response.data;
  }

  /** Dump the whole company brain for a project, grouped by source. */
  async companyBrain(opts: { project?: string; maxTokens?: number } = {}): Promise<{
    project: string;
    total_memories: number;
    total_sources: number;
    sources: Array<Record<string, unknown>>;
    sources_index: Array<Record<string, unknown>>;
    text: string;
    citations: Array<Record<string, unknown>>;
    generated_at: string;
  }> {
    const project = opts.project || this.project || "default";
    const response = await this._client.request<{
      project: string;
      total_memories: number;
      total_sources: number;
      sources: Array<Record<string, unknown>>;
      sources_index: Array<Record<string, unknown>>;
      text: string;
      citations: Array<Record<string, unknown>>;
      generated_at: string;
    }>({
      endpoint: `/v1/company-brain?project=${encodeURIComponent(project)}&maxTokens=${encodeURIComponent(String(opts.maxTokens || 8000))}`,
      method: "GET",
      operation: "company_brain",
    });
    return response.data;
  }

  /** Search the company brain for a question, returning a context block + citations. */
  async askBrain(input: {
    query: string;
    project?: string;
    topK?: number;
    maxTokens?: number;
    includeAgentMemories?: boolean;
  }): Promise<{
    query: string;
    context: string;
    citations: Array<Record<string, unknown>>;
    hits: number;
    total_tokens: number;
  }> {
    const project = input.project || this.project || "default";
    const response = await this._client.request<{
      query: string;
      context: string;
      citations: Array<Record<string, unknown>>;
      hits: number;
      total_tokens: number;
    }>({
      endpoint: "/v1/company-brain/ask",
      method: "POST",
      operation: "ask_brain",
      body: {
        query: input.query,
        project,
        top_k: input.topK,
        max_tokens: input.maxTokens,
        include_agent_memories: input.includeAgentMemories,
      },
    });
    return response.data;
  }

  /** Build an LLM-ready system prompt + message list, grounded in the company brain. */
  async feedAgent(input: {
    query?: string;
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
    project?: string;
    maxContextTokens?: number;
    includeAgentMemories?: boolean;
  }): Promise<{
    system_prompt: string;
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
    citations: Array<Record<string, unknown>>;
    context_tokens: number;
  }> {
    const project = input.project || this.project || "default";
    const response = await this._client.request<{
      system_prompt: string;
      messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
      citations: Array<Record<string, unknown>>;
      context_tokens: number;
    }>({
      endpoint: "/v1/company-brain/feed",
      method: "POST",
      operation: "feed_agent",
      body: {
        query: input.query,
        messages: input.messages,
        project,
        max_context_tokens: input.maxContextTokens,
        include_agent_memories: input.includeAgentMemories,
      },
    });
    return response.data;
  }

  session(sessionId: string): SessionLearnScope {
    if (!sessionId || !sessionId.trim()) throw new Error("RetainDB: sessionId is required and cannot be empty");

    const applySessionDefaults = (params: LearnInput, userId?: string): LearnInput => {
      if (params.mode !== "conversation") {
        return {
          ...params,
          project: params.project || this.project || "default",
        };
      }
      return {
        ...params,
        project: params.project || this.project || "default",
        session_id: params.session_id || sessionId,
        user_id: params.user_id || userId,
      };
    };

    return {
      learn: (params) => this.learn(applySessionDefaults(params)),
      user: (userId: string) => ({
        learn: (params) => this.learn(applySessionDefaults(params, userId)),
      }),
    };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const guarded = promise.then(
    (value) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      return value;
    },
    (error) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      throw error;
    }
  );
  const timeout = new Promise<T>((_, reject) => {
    timeoutHandle = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
  });
  return Promise.race([guarded, timeout]);
}

function extractMemoryItems(response: MemorySearchResponse): MemoryItem[] {
  const results = Array.isArray(response?.results) ? response.results : [];
  return results
    .map((r: any) => ({
      id: String(r?.memory?.id ?? r?.id ?? ""),
      content: String(r?.memory?.content ?? r?.content ?? ""),
      type: String(r?.memory?.memory_type ?? r?.memory?.type ?? r?.type ?? "factual"),
    }))
    .filter((m) => m.content);
}

function formatContext(response: MemorySearchResponse): string {
  const results = Array.isArray(response?.results) ? response.results : [];
  if (results.length === 0) return "";
  return results
    .map((r: any) => r?.memory?.content ?? r?.content ?? "")
    .filter(Boolean)
    .join("\n");
}

function findLastUserMessage(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return messages[i].content;
  }
  return messages[messages.length - 1]?.content ?? "";
}

/** Build the best retrieval query for a given message list.
 *  Short/vague messages ("yes", "ok", "?") make terrible vector queries —
 *  fall back to the last few user turns combined for better recall. */
function buildRetrievalQuery(messages: Message[]): string {
  const last = findLastUserMessage(messages);
  if (last.trim().length >= 20) return last;
  // Combine recent user turns for context
  const recent = messages
    .filter((m) => m.role === "user")
    .slice(-3)
    .map((m) => m.content)
    .join(" ")
    .trim();
  return recent.slice(0, 400) || last;
}

function buildTurnContext(messages: Message[], context: string): TurnContext {
  if (!context) {
    return { context: "", messages };
  }
  const systemMessage: Message = {
    role: "system",
    content: `User context:\n${context}`,
  };
  // Prepend or replace existing system message
  const hasSystem = messages.length > 0 && messages[0].role === "system";
  const enrichedMessages: Message[] = hasSystem
    ? [
        { role: "system", content: `${messages[0].content}\n\nUser context:\n${context}` },
        ...messages.slice(1),
      ]
    : [systemMessage, ...messages];
  return { context, messages: enrichedMessages };
}

