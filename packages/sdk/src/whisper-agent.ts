/**
 * RetainDB - Simple Memory Layer for AI Agents
 * 
 * Two methods:
 * - getContext(): Retrieve relevant context before LLM call
 * - capture(): Extract and store memories after LLM response
 * 
 * Zero magic - you control when to get context and when to capture
 */

import { RetainDBClient } from "./whisper.js";
import {
  RetainDBContext,
  type LearnInput,
  type LearnResult,
  type RetainDBConfig,
  type QueryResult,
} from "./index.js";

const DEPRECATION_WARNINGS = new Set<string>();

function warnDeprecatedOnce(key: string, message: string): void {
  if (DEPRECATION_WARNINGS.has(key)) return;
  DEPRECATION_WARNINGS.add(key);
  if (typeof console !== "undefined" && typeof console.warn === "function") {
    console.warn(message);
  }
}

export interface RetainDBOptions extends RetainDBConfig {
  /**
   * Maximum context results to retrieve.
   * Default: 10
   */
  contextLimit?: number;
  
  /**
   * Which memory types to use.
   * Default: all 7 types
   */
  memoryTypes?: Array<"factual" | "preference" | "event" | "relationship" | "opinion" | "goal" | "instruction">;
  
  /**
   * Prefix for context injection.
   * Default: "Relevant context:"
   */
  contextPrefix?: string;

  /**
   * Extract structured memories before writing.
   * Default: true
   */
  autoExtract?: boolean;

  /**
   * Minimum extraction confidence for auto-write.
   * Default: 0.65
   */
  autoExtractMinConfidence?: number;

  /**
   * Maximum extracted memories to write per remember/capture call.
   * Default: 5
   */
  maxMemoriesPerCapture?: number;
}

export interface ContextResult {
  context: string;
  results: QueryResult["results"];
  count: number;
}

export interface RememberResult {
  success: boolean;
  memoryId?: string;
  memoryIds?: string[];
  extracted?: number;
}

/**
 * Simple, transparent memory layer
 * 
 * @example
 * ```typescript
 * import { RetainDB } from '@retaindb/sdk';
 * 
 * const retaindb = new RetainDB({
 *   apiKey: process.env.RETAINDB_API_KEY,
 *   project: 'my-app'
 * });
 * 
 * // BEFORE: Get relevant context
 * const { context, results } = await retaindb.getContext("What does user prefer?");
 * 
 * // Inject context into your LLM prompt
 * const prompt = `${context}\n\nUser: What does user prefer?`;
 * const response = await llm.complete(prompt);
 * 
 * // AFTER: Capture what happened
 * await retaindb.capture(response);
 * // → Memories extracted & stored (async)
 * ```
 */
export class RetainDB {
  private client: RetainDBContext;
  private runtimeClient: RetainDBClient;
  private options: Required<RetainDBOptions>;
  
  private sessionId?: string;
  private userId?: string;

  constructor(options: RetainDBOptions) {
    if (!options.apiKey) {
      throw new Error("API key is required");
    }
    
    const clientConfig: RetainDBConfig = { // RetainDBConfig alias used for backward compat
      apiKey: options.apiKey,
      baseUrl: options.baseUrl,
      project: options.project || "default",
    };
    if (options.timeoutMs) clientConfig.timeoutMs = options.timeoutMs;
    if (options.retry) clientConfig.retry = options.retry;
    
    this.client = new RetainDBContext(clientConfig);
    this.runtimeClient = new RetainDBClient({
      apiKey: options.apiKey,
      baseUrl: options.baseUrl,
      project: options.project || "default",
    });
    warnDeprecatedOnce(
      "whisper_agent_wrapper",
      "[RetainDB SDK] Legacy Whisper wrapper aliases are supported for v2 compatibility. Prefer RetainDBClient for new integrations."
    );
    
    const finalRetry = options.retry || { maxAttempts: 3, baseDelayMs: 250, maxDelayMs: 2000 };
    this.options = {
      apiKey: options.apiKey,
      baseUrl: options.baseUrl || "https://api.retaindb.com",
      project: options.project || "default",
      timeoutMs: options.timeoutMs || 15000,
      retry: finalRetry,
      contextLimit: options.contextLimit ?? 10,
      memoryTypes: options.memoryTypes ?? ["factual", "preference", "event", "goal", "relationship", "opinion", "instruction"],
      contextPrefix: options.contextPrefix ?? "Relevant context:",
      autoExtract: options.autoExtract ?? true,
      autoExtractMinConfidence: options.autoExtractMinConfidence ?? 0.65,
      maxMemoriesPerCapture: options.maxMemoriesPerCapture ?? 5,
    };
  }

  /**
   * Set session ID for conversation tracking
   */
  session(sessionId: string): this {
    this.sessionId = sessionId;
    return this;
  }

  /**
   * Set user ID for user-specific memories
   */
  user(userId: string): this {
    this.userId = userId;
    return this;
  }

  /**
   * Get relevant context BEFORE your LLM call
   * 
   * @param query - What you want to know / user question
   * @returns Context string and raw results
   * 
   * @example
   * ```typescript
   * const { context, results, count } = await retaindb.getContext(
   *   "What are user's preferences?",
   *   { userId: "user-123" }
   * );
   * 
   * // Results: [
   * //   { content: "User prefers dark mode", type: "preference", score: 0.95 },
   * //   { content: "Allergic to nuts", type: "factual", score: 0.89 }
   * // ]
   * ```
   */
  async getContext(
    query: string,
    options?: {
      userId?: string;
      sessionId?: string;
      project?: string;
      limit?: number;
    }
  ): Promise<ContextResult> {
    const runtime = this.runtimeClient.createAgentRuntime({
      project: options?.project ?? this.options.project,
      userId: options?.userId ?? this.userId,
      sessionId: options?.sessionId ?? this.sessionId,
      topK: options?.limit ?? this.options.contextLimit,
      clientName: "retaindb-wrapper",
    });
    const prepared = await runtime.beforeTurn({
      userMessage: query,
    });

    const results: QueryResult["results"] = prepared.items.map((item, index) => ({
      id: item.id || `runtime_${index}`,
      content: item.content,
      score: item.score,
      metadata: item.metadata || {},
      source: item.type === "memory" ? "memory" : "runtime",
      document: item.sourceQuery,
      type: item.type,
      retrieval_source: item.type === "memory" ? "memory" : "runtime",
    }));

    const context = results
      .map((r, i) => `[${i + 1}] ${r.content}`)
      .join("\n");

    return {
      context: context ? `${this.options.contextPrefix}\n${context}` : "",
      results,
      count: prepared.items.length,
    };
  }

  /**
   * Remember what happened AFTER your LLM response
   * 
   * Fire-and-forget - doesn't block your response
   * 
   * @param content - What your LLM responded with
   * @returns Promise that resolves when stored (or fails silently)
   * 
   * @example
   * ```typescript
   * const llmResponse = "I've set your theme to dark mode and removed nuts from recommendations.";
   * 
   * await retaindb.remember(llmResponse, { userId: "user-123" });
   * // → Auto-extracts: "theme set to dark mode", "nut allergy"
   * // → Stored as preferences
   * ```
   */
  async remember(
    content: string,
    options?: {
      userId?: string;
      sessionId?: string;
      project?: string;
    }
  ): Promise<RememberResult> {
    if (!content || content.length < 5) {
      return { success: false };
    }

    try {
      if (this.options.autoExtract) {
        const extraction = await this.client.extractMemories({
          project: options?.project ?? this.options.project,
          message: content,
          user_id: options?.userId ?? this.userId,
          session_id: options?.sessionId ?? this.sessionId,
          enable_pattern: true,
          enable_inference: true,
          min_confidence: this.options.autoExtractMinConfidence,
        });

        const extractedMemories = (extraction.all || [])
          .filter((m) => (m.confidence || 0) >= this.options.autoExtractMinConfidence)
          .slice(0, this.options.maxMemoriesPerCapture);

        if (extractedMemories.length > 0) {
          const bulk = await this.client.addMemoriesBulk({
            project: options?.project ?? this.options.project,
            write_mode: "async",
            memories: extractedMemories.map((m) => ({
              content: m.content,
              memory_type: m.memoryType,
              user_id: options?.userId ?? this.userId,
              session_id: options?.sessionId ?? this.sessionId,
              importance: Math.max(0.5, Math.min(1, m.confidence || 0.7)),
              confidence: m.confidence || 0.7,
              entity_mentions: m.entityMentions || [],
              event_date: m.eventDate || undefined,
              metadata: {
                extracted: true,
                extraction_method: extraction.extractionMethod,
                extraction_reasoning: m.reasoning,
                inferred: Boolean(m.inferred),
              },
            })),
          });

          const memoryIds = this.extractMemoryIdsFromBulkResponse(bulk);
          return {
            success: true,
            memoryId: memoryIds[0],
            memoryIds: memoryIds.length > 0 ? memoryIds : undefined,
            extracted: extractedMemories.length,
          };
        }
      }

      // Fallback: write the raw content as one memory.
      const result = await this.client.addMemory({
        project: options?.project ?? this.options.project,
        content,
        user_id: options?.userId ?? this.userId,
        session_id: options?.sessionId ?? this.sessionId,
      });

      return {
        success: true,
        memoryId: (result as any)?.id
      };
    } catch (error) {
      console.error("[RetainDB] Remember failed:", error);
      return { success: false };
    }
  }

  /**
   * Alias for remember() - same thing
   */
  async capture(
    content: string,
    options?: {
      userId?: string;
      sessionId?: string;
      project?: string;
    }
  ): Promise<RememberResult> {
    return this.remember(content, options);
  }

  /**
   * Capture from multiple messages (e.g., full conversation)
   */
  async captureSession(
    messages: Array<{ role: string; content: string }>,
    options?: {
      userId?: string;
      sessionId?: string;
      project?: string;
      auto_learn?: boolean;
    }
  ): Promise<{ success: boolean; extracted: number }> {
    if (options?.auto_learn === false) {
      return { success: true, extracted: 0 };
    }
    try {
      const filteredMessages = messages.filter((m) => m.role !== "system");
      const runtime = this.runtimeClient.createAgentRuntime({
        project: options?.project ?? this.options.project,
        userId: options?.userId ?? this.userId,
        sessionId: options?.sessionId ?? this.sessionId ?? "default",
        clientName: "retaindb-wrapper",
      });
      const result = await runtime.afterTurn({
        userMessage: [...filteredMessages].reverse().find((m) => m.role === "user")?.content || "",
        assistantMessage: [...filteredMessages].reverse().find((m) => m.role === "assistant")?.content || "",
        auto_learn: options?.auto_learn,
      });

      return { 
        success: true, 
        extracted: result.memoriesCreated ?? 0,
      };
    } catch (error) {
      const fallback = await this.fallbackCaptureViaAddMemory(messages, options);
      if (fallback.success) {
        return fallback;
      }
      console.error("[RetainDB] Session capture failed:", error);
      return { success: false, extracted: 0 };
    }
  }

  /**
   * Run a full agent turn with automatic memory read (before) + write (after).
   */
  async runTurn(params: {
    userMessage: string;
    generate: (prompt: string) => Promise<string>;
    userId?: string;
    sessionId?: string;
    project?: string;
    limit?: number;
    auto_learn?: boolean;
  }): Promise<{
    response: string;
    context: string;
    count: number;
    extracted: number;
  }> {
    const contextResult = await this.getContext(params.userMessage, {
      userId: params.userId,
      sessionId: params.sessionId,
      project: params.project,
      limit: params.limit,
    });

    const prompt = contextResult.context
      ? `${contextResult.context}\n\nUser: ${params.userMessage}`
      : params.userMessage;

    const response = await params.generate(prompt);

    const captureResult = await this.captureSession(
      [
        { role: "user", content: params.userMessage },
        { role: "assistant", content: response },
      ],
        {
          userId: params.userId,
          sessionId: params.sessionId,
          project: params.project,
          auto_learn: params.auto_learn,
        }
      );

    return {
      response,
      context: contextResult.context,
      count: contextResult.count,
      extracted: captureResult.extracted,
    };
  }

  async learn(input: LearnInput): Promise<LearnResult> {
    const project = input.project ?? this.options.project;
    if (input.mode === "conversation") {
      void this.runtimeClient.add(
        (input as any).messages || [],
        {
          project,
          userId: (input as any).user_id ?? this.userId,
          sessionId: (input as any).session_id || this.sessionId || "default",
        },
      );
      return { success: true, mode: "async", jobId: undefined } as unknown as LearnResult;
    }
    return this.runtimeClient.ingest((input as any).url, {
      project,
      name: (input as any).name,
      token: (input as any).token,
    });
  }

  /**
   * Direct access to RetainDBContext for advanced usage
   */
  raw(): RetainDBContext {
    return this.client;
  }

  private extractMemoryIdsFromBulkResponse(bulkResponse: any): string[] {
    const ids: string[] = [];

    if (Array.isArray(bulkResponse?.memories)) {
      for (const memory of bulkResponse.memories) {
        if (memory?.id) ids.push(memory.id);
      }
    }

    if (bulkResponse?.memory?.id) {
      ids.push(bulkResponse.memory.id);
    }

    if (bulkResponse?.id) {
      ids.push(bulkResponse.id);
    }

    return Array.from(new Set(ids));
  }

  private async fallbackCaptureViaAddMemory(
    messages: Array<{ role: string; content: string }>,
    options?: {
      userId?: string;
      sessionId?: string;
      project?: string;
    }
  ): Promise<{ success: boolean; extracted: number }> {
    const userMessages = messages
      .filter((m) => m.role === "user")
      .map((m) => (m.content || "").trim())
      .filter((content) => content.length >= 5)
      .slice(-2);

    if (userMessages.length === 0) {
      return { success: false, extracted: 0 };
    }

    let extracted = 0;

    for (const content of userMessages) {
      try {
        await this.client.addMemory({
          project: options?.project ?? this.options.project,
          content,
          memory_type: "factual",
          user_id: options?.userId ?? this.userId,
          session_id: options?.sessionId ?? this.sessionId,
          allow_legacy_fallback: true,
        });
        extracted += 1;
      } catch {
        // Continue best-effort; one failed write should not block other writes.
      }
    }

    return { success: extracted > 0, extracted };
  }
}

export default RetainDB;

// Deprecated alias
export { RetainDB as Whisper };
export type { RetainDBOptions as WhisperOptions };
