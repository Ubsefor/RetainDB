import { RuntimeClient, RuntimeClientError } from "./core/client.js";
import { SearchResponseCache } from "./core/cache.js";
import { DiagnosticsStore } from "./core/telemetry.js";
import { InMemoryQueueStore, WriteQueue, createStorageQueueStore, createFileQueueStore } from "./core/queue.js";
import type { CompatMode, RetryPolicy, TimeoutBudgets } from "./core/types.js";
import { MemoryModule } from "./modules/memory.js";
import { SessionModule } from "./modules/session.js";
import { ProfileModule } from "./modules/profile.js";
import { AnalyticsModule } from "./modules/analytics.js";
import type {
  LearnInput,
  LearnResult,
  LearnSourceType,
  MemoryKind,
  MemoryScopeTarget,
  MemorySearchResponse,
  MemoryWriteAck,
  PromotionMode,
  SessionWorkEvent,
} from "./modules/types.js";
import { WhisperAgentRuntime, type AgentRunContext, type AgentRuntimeOptions } from "./agent-runtime.js";
import type { Project, QueryParams, QueryResult } from "./index.js";
import { RetainDBError as WhisperError, type RetainDBErrorCode as WhisperErrorCode } from "./errors.js";

const PROJECT_CACHE_TTL_MS = 30_000;
const IDENTITY_WARNINGS = new Set<string>();
const DEFAULT_PROJECT_REF = "default";

export type RetainDBIdentityMode = "demo-local" | "app-identity";
/** @deprecated Use RetainDBIdentityMode */
export type WhisperIdentityMode = RetainDBIdentityMode;
export type RetainDBEnvironment = "local" | "staging" | "production";
/** @deprecated Use RetainDBEnvironment */
export type WhisperEnvironment = RetainDBEnvironment;

export interface RetainDBResolvedIdentity {
  userId: string;
  sessionId?: string;
}
/** @deprecated Use RetainDBResolvedIdentity */
export type WhisperResolvedIdentity = RetainDBResolvedIdentity;

export interface RetainDBPreflightCheck {
  check: string;
  ok: boolean;
  message: string;
  hint?: string;
}
/** @deprecated Use RetainDBPreflightCheck */
export type WhisperPreflightCheck = RetainDBPreflightCheck;

export interface RetainDBPreflightResult {
  ok: boolean;
  checks: RetainDBPreflightCheck[];
  requestId: string;
  identityMode: RetainDBIdentityMode;
  environment: RetainDBEnvironment;
}
/** @deprecated Use RetainDBPreflightResult */
export type WhisperPreflightResult = RetainDBPreflightResult;

export interface RetainDBClientConfig {
  apiKey: string;
  baseUrl?: string;
  project?: string;
  identityMode?: RetainDBIdentityMode;
  getIdentity?: () => RetainDBResolvedIdentity | Promise<RetainDBResolvedIdentity>;
  environment?: RetainDBEnvironment;
  strictIdentityMode?: boolean;
  compatMode?: CompatMode;
  fetch?: typeof fetch;
  timeouts?: Partial<TimeoutBudgets>;
  retryPolicy?: RetryPolicy;
  cache?: {
    enabled?: boolean;
    ttlMs?: number;
    capacity?: number;
  };
  queue?: {
    enabled?: boolean;
    maxBatchSize?: number;
    flushIntervalMs?: number;
    maxAttempts?: number;
    persistence?: "memory" | "storage" | "file";
    filePath?: string;
  };
  telemetry?: {
    enabled?: boolean;
    maxEntries?: number;
  };
}
/** @deprecated Use RetainDBClientConfig */
export type WhisperClientConfig = RetainDBClientConfig;

export interface RunContext {
  project?: string;
  userId?: string;
  sessionId?: string;
  agentId?: string;
  taskId?: string;
  traceId?: string;
}

function isLikelyProjectId(projectRef: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(projectRef);
}

function randomRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `req_${Math.random().toString(36).slice(2, 11)}`;
}

function parseIdentityMode(value: unknown): WhisperIdentityMode {
  return value === "app-identity" ? "app-identity" : "demo-local";
}

function parseEnvironment(value: unknown): WhisperEnvironment {
  if (value === "staging" || value === "production") return value;
  return "local";
}

function classifyRuntimeErrorCode(error: RuntimeClientError): WhisperErrorCode {
  if (error.code === "MISSING_PROJECT") return "MISSING_PROJECT";
  if (error.code === "TIMEOUT") return "TIMEOUT";
  if (error.code === "NETWORK_ERROR") return "NETWORK_ERROR";
  if (error.code === "VALIDATION_ERROR") return "VALIDATION_ERROR";
  if (error.status === 401 || error.status === 403) return "INVALID_API_KEY";
  if (error.status === 408) return "TIMEOUT";
  if (error.status === 429) return "RATE_LIMITED";
  if (error.status && error.status >= 500) return "TEMPORARY_UNAVAILABLE";
  if (error.code === "PROJECT_NOT_FOUND" || error.code === "NOT_FOUND") return "PROJECT_NOT_FOUND";
  return "REQUEST_FAILED";
}

export interface RememberParams {
  messages: Array<{ role: string; content: string; timestamp?: string }>;
  userId?: string;
  sessionId?: string;
  project?: string;
}

export interface IngestParams {
  url: string;
  name?: string;
  token?: string;
  project?: string;
}

export type QueryInput = Omit<QueryParams, "query"> & {
  query?: string;
  q?: string;
  userId?: string;
};

/** Options for db.add() — simple memory write or conversation ingestion */
export interface AddOptions {
  userId?: string;
  sessionId?: string;
  agentId?: string;
  taskId?: string;
  project?: string;
  /** Memory kind for direct writes (e.g. "factual", "event") */
  type?: MemoryKind;
  scopeTarget?: MemoryScopeTarget;
  promotionMode?: PromotionMode;
  importance?: number;
  metadata?: Record<string, unknown>;
}

/** Options for db.search() — clean query surface without internal knobs */
export interface SearchOptions {
  userId?: string;
  sessionId?: string;
  agentId?: string;
  taskId?: string;
  project?: string;
  topK?: number;
  scopeTargets?: MemoryScopeTarget[];
  /** "fast" = low-latency, "balanced" = default, "quality" = best recall */
  quality?: "fast" | "balanced" | "quality";
}

/** Result from db.search() — context string ready for prompt injection */
export interface SearchResult {
  /** Pre-assembled context string — drop directly into your system prompt */
  context: string;
  memories: Array<{
    id: string;
    content: string;
    score: number;
    type?: string;
    createdAt?: string;
  }>;
  cached: boolean;
}

/** Options for db.from() — source ingestion (GitHub, PDF, web, video) */
export interface FromOptions {
  name?: string;
  /** Auth token for private repos */
  token?: string;
  project?: string;
}

function detectSourceType(url: string): { type: LearnSourceType; owner?: string; repo?: string } {
  // [^/]+ captures only the owner/repo segments; anything after (e.g. /tree/main/subdir) is ignored
  const ghMatch = url.match(/github\.com\/([^/?#]+)\/([^/?#]+)/);
  if (ghMatch) {
    const [, owner, repo] = ghMatch;
    // strip .git suffix if present (e.g. github.com/org/repo.git)
    return { type: "github", owner, repo: repo.replace(/\.git$/, "") };
  }
  if (/youtube\.com|youtu\.be|loom\.com/.test(url)) return { type: "video" };
  if (/\.pdf(\?|$)/.test(url)) return { type: "pdf" };
  return { type: "web" };
}

export class RetainDBClient {
  readonly diagnostics: {
    getLast: (limit?: number) => ReturnType<DiagnosticsStore["getLast"]>;
    subscribe: (fn: Parameters<DiagnosticsStore["subscribe"]>[0]) => ReturnType<DiagnosticsStore["subscribe"]>;
    snapshot: () => ReturnType<DiagnosticsStore["snapshot"]>;
  };

  readonly queue: {
    flush: () => Promise<void>;
    status: () => ReturnType<WriteQueue["status"]>;
  };

  readonly memory: {
    add: (params: Parameters<MemoryModule["add"]>[0]) => Promise<MemoryWriteAck>;
    addBulk: (params: Parameters<MemoryModule["addBulk"]>[0]) => Promise<MemoryWriteAck>;
    search: (params: Parameters<MemoryModule["search"]>[0]) => Promise<MemorySearchResponse>;
    get: (memoryId: string) => Promise<{ memory: Record<string, unknown> }>;
    getUserProfile: (params: Parameters<MemoryModule["getUserProfile"]>[0]) => ReturnType<MemoryModule["getUserProfile"]>;
    getSessionMemories: (params: Parameters<MemoryModule["getSessionMemories"]>[0]) => ReturnType<MemoryModule["getSessionMemories"]>;
    update: (memoryId: string, params: { content: string; reasoning?: string }) => Promise<{ success: boolean }>;
    delete: (memoryId: string) => Promise<{ success: boolean; deleted: string }>;
    flag: (params: { memoryId: string; reason: string; severity?: "low" | "medium" | "high" }) => Promise<{ success: boolean }>;
  };

  readonly session: {
    start: (params: Parameters<SessionModule["start"]>[0]) => ReturnType<SessionModule["start"]>;
    event: (params: Parameters<SessionModule["event"]>[0]) => ReturnType<SessionModule["event"]>;
    suspend: (params: Parameters<SessionModule["suspend"]>[0]) => ReturnType<SessionModule["suspend"]>;
    resume: (params: Parameters<SessionModule["resume"]>[0]) => ReturnType<SessionModule["resume"]>;
    end: (params: Parameters<SessionModule["end"]>[0]) => ReturnType<SessionModule["end"]>;
  };

  readonly profile: {
    getUserProfile: (params: Parameters<ProfileModule["getUserProfile"]>[0]) => ReturnType<ProfileModule["getUserProfile"]>;
    getSessionMemories: (params: Parameters<ProfileModule["getSessionMemories"]>[0]) => ReturnType<ProfileModule["getSessionMemories"]>;
  };

  readonly analytics: {
    diagnosticsSnapshot: () => ReturnType<AnalyticsModule["diagnosticsSnapshot"]>;
    queueStatus: () => ReturnType<AnalyticsModule["queueStatus"]>;
  };

  private readonly runtimeClient: RuntimeClient;
  private readonly diagnosticsStore: DiagnosticsStore;
  private readonly searchCache: SearchResponseCache<MemorySearchResponse>;
  private readonly writeQueue: WriteQueue;
  private readonly memoryModule: MemoryModule;
  private readonly sessionModule: SessionModule;
  private readonly profileModule: ProfileModule;
  private readonly analyticsModule: AnalyticsModule;
  private readonly projectRefToId = new Map<string, string>();
  private readonly identityMode: RetainDBIdentityMode;
  private readonly environment: RetainDBEnvironment;
  private readonly strictIdentityMode: boolean;
  private readonly getIdentity?: () => WhisperResolvedIdentity | Promise<WhisperResolvedIdentity>;
  private projectCache: Project[] = [];
  private projectCacheExpiresAt = 0;

  constructor(private readonly config: RetainDBClientConfig) {
    const env = (typeof process !== "undefined" ? process.env : {}) as Record<string, string | undefined>;
    this.identityMode = parseIdentityMode(config.identityMode || env.RETAINDB_IDENTITY_MODE);
    this.environment = parseEnvironment(config.environment || env.RETAINDB_ENV || (env.NODE_ENV === "production" ? "production" : "local"));
    this.strictIdentityMode = config.strictIdentityMode ?? env.RETAINDB_DEMO_LOCAL_STRICT === "true";
    this.getIdentity = config.getIdentity;
    this.enforceIdentityModeGuardrail();

    this.diagnosticsStore = new DiagnosticsStore(config.telemetry?.maxEntries || 1000);
    this.runtimeClient = new RuntimeClient(
      {
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        compatMode: config.compatMode || "fallback",
        timeouts: config.timeouts,
        retryPolicy: config.retryPolicy,
        fetchImpl: config.fetch,
      },
      this.diagnosticsStore,
    );
    this.searchCache = new SearchResponseCache<MemorySearchResponse>(
      config.cache?.ttlMs ?? 7000,
      config.cache?.capacity ?? 500,
    );

    const queueStore = this.createQueueStore(config);
    this.writeQueue = new WriteQueue({
      store: queueStore,
      maxBatchSize: config.queue?.maxBatchSize ?? 50,
      flushIntervalMs: config.queue?.flushIntervalMs ?? 100,
      maxAttempts: config.queue?.maxAttempts ?? 2,
      flushHandler: async (items) => {
        if (items.length === 0) return;
        const project = items[0].project;
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

        try {
          await this.runtimeClient.request({
            endpoint: "/v1/memory/bulk",
            method: "POST",
            operation: "bulk",
            body: {
              project,
              write_mode: "async",
              memories,
            },
          });
        } catch (error) {
          if (
            this.runtimeClient.getCompatMode() !== "fallback" ||
            !(error instanceof RuntimeClientError) ||
            error.status !== 404
          ) {
            throw error;
          }
          await Promise.all(
            memories.map(async (memory) => {
              try {
                await this.runtimeClient.request({
                  endpoint: "/v1/memory",
                  method: "POST",
                  operation: "writeAck",
                  body: {
                    project,
                    ...memory,
                    write_mode: "sync",
                  },
                });
              } catch (fallbackError) {
                if (
                  this.runtimeClient.getCompatMode() !== "fallback" ||
                  !(fallbackError instanceof RuntimeClientError) ||
                  fallbackError.status !== 404
                ) {
                  throw fallbackError;
                }
                await this.runtimeClient.request({
                  endpoint: "/v1/memories",
                  method: "POST",
                  operation: "writeAck",
                  body: {
                    project,
                    ...memory,
                    memory_type: memory.memory_type === "event" ? "episodic" : memory.memory_type,
                  },
                });
              }
            })
          );
        }
      },
    });
    if (config.queue?.enabled !== false) {
      void this.writeQueue.start();
    }

    this.memoryModule = new MemoryModule(
      this.runtimeClient,
      this.searchCache,
      this.writeQueue,
      {
        defaultProject: config.project,
        cacheEnabled: config.cache?.enabled !== false,
        queueEnabled: config.queue?.enabled !== false,
      },
    );
    this.sessionModule = new SessionModule(this.memoryModule, config.project);
    this.profileModule = new ProfileModule(this.memoryModule);
    this.analyticsModule = new AnalyticsModule(this.diagnosticsStore, this.writeQueue);

    this.diagnostics = {
      getLast: (limit?: number) => this.diagnosticsStore.getLast(limit),
      subscribe: (fn) => this.diagnosticsStore.subscribe(fn),
      snapshot: () => this.diagnosticsStore.snapshot(),
    };
    this.queue = {
      flush: () => this.writeQueue.flush(),
      status: () => this.writeQueue.status(),
    };
    this.memory = {
      add: (params) => this.runOrThrow(async () => this.memoryModule.add(await this.withIdentity(params))),
      addBulk: (params) => this.runOrThrow(async () => this.memoryModule.addBulk({
        ...params,
        memories: await Promise.all(params.memories.map((memory) => this.withIdentity(memory))),
      })),
      search: (params) => this.runOrThrow(async () => this.memoryModule.search(await this.withIdentity(params))),
      get: (memoryId) => this.runOrThrow(async () => this.memoryModule.get(memoryId)),
      getUserProfile: (params) => this.runOrThrow(async () => this.profileModule.getUserProfile(await this.withIdentity(params, true))),
      getSessionMemories: (params) => this.runOrThrow(async () => this.profileModule.getSessionMemories(await this.withIdentity(params))),
      update: (memoryId, params) => this.runOrThrow(async () => this.memoryModule.update(memoryId, params)),
      delete: (memoryId) => this.runOrThrow(async () => this.memoryModule.delete(memoryId)),
      flag: (params) => this.runOrThrow(async () => this.memoryModule.flag(params)),
    };
    this.session = {
      start: (params) => this.runOrThrow(async () => this.sessionModule.start(await this.withSessionIdentity(params))),
      event: (params) => this.runOrThrow(async () => this.sessionModule.event(params)),
      suspend: (params) => this.runOrThrow(async () => this.sessionModule.suspend(params)),
      resume: (params) => this.runOrThrow(async () => this.sessionModule.resume(params)),
      end: (params) => this.runOrThrow(async () => this.sessionModule.end(params)),
    };
    this.profile = {
      getUserProfile: (params) => this.runOrThrow(async () => this.profileModule.getUserProfile(await this.withIdentity(params, true))),
      getSessionMemories: (params) => this.runOrThrow(async () => this.profileModule.getSessionMemories(await this.withIdentity(params))),
    };
    this.analytics = {
      diagnosticsSnapshot: () => this.analyticsModule.diagnosticsSnapshot(),
      queueStatus: () => this.analyticsModule.queueStatus(),
    };
  }

  private enforceIdentityModeGuardrail(requestId = randomRequestId()): void {
    if (this.identityMode !== "demo-local") return;
    if (this.environment === "local") return;

    const message =
      "[RetainDB SDK] RETAINDB_IDENTITY_MODE=demo-local is intended only for local development. " +
      "Switch to app-identity and provide getIdentity() or per-call user_id/session_id.";

    if (this.strictIdentityMode || this.environment === "production") {
      throw new WhisperError({
        code: "MISCONFIGURED_IDENTITY_MODE",
        message,
        retryable: false,
        hint: "Set identityMode: 'app-identity' and provide a getIdentity() function that returns { userId, sessionId? }. " +
          "To override for testing, set environment: 'local' explicitly in RetainDBClient config.",
      });
    }

    const warningKey = `${this.environment}:${this.identityMode}`;
    if (!IDENTITY_WARNINGS.has(warningKey)) {
      IDENTITY_WARNINGS.add(warningKey);
      if (typeof console !== "undefined" && typeof console.warn === "function") {
        console.warn(`${message} requestId=${requestId}`);
      }
    }
  }

  private toWhisperError(error: unknown, hint?: string): WhisperError {
    if (error instanceof WhisperError) return error;
    if (error instanceof RuntimeClientError) {
      return new WhisperError({
        code: classifyRuntimeErrorCode(error),
        message: error.message,
        status: error.status,
        retryable: error.retryable,
        hint: error.hint || hint,
        requestId: error.requestId || error.traceId,
        details: error.details,
        cause: error,
      });
    }
    if (error instanceof Error) {
      return new WhisperError({
        code: "REQUEST_FAILED",
        message: error.message,
        retryable: false,
        hint,
        cause: error,
      });
    }
    return new WhisperError({
      code: "REQUEST_FAILED",
      message: "Unknown SDK error",
      retryable: false,
      hint,
      details: error,
    });
  }

  private async runOrThrow<T>(work: () => Promise<T>, hint?: string): Promise<T> {
    try {
      return await work();
    } catch (error) {
      throw this.toWhisperError(error, hint);
    }
  }

  private async resolveIdentityOverride(): Promise<WhisperResolvedIdentity | null> {
    if (!this.getIdentity) return null;
    const resolved = await this.getIdentity();
    const userId = String(resolved?.userId || "").trim();
    const sessionId = resolved?.sessionId ? String(resolved.sessionId).trim() : undefined;
    if (!userId) {
      throw new WhisperError({
        code: "AUTH_IDENTITY_INVALID",
        message: "getIdentity() returned an invalid identity payload.",
        retryable: false,
        hint: "Return { userId, sessionId? } from getIdentity() in RetainDBClient.",
      });
    }
    return {
      userId,
      sessionId: sessionId || undefined,
    };
  }

  private async withIdentity<T extends { user_id?: string; session_id?: string }>(
    params: T,
    requireUser = false,
  ): Promise<T> {
    const currentUser = params.user_id ? String(params.user_id).trim() : "";
    const currentSession = params.session_id ? String(params.session_id).trim() : "";
    if (currentUser) {
      return {
        ...params,
        user_id: currentUser,
        session_id: currentSession || params.session_id,
      };
    }

    const resolved = await this.resolveIdentityOverride();
    if (resolved) {
      return {
        ...params,
        user_id: resolved.userId,
        session_id: currentSession || resolved.sessionId,
      };
    }

    if (requireUser || this.identityMode === "app-identity") {
      throw new WhisperError({
        code: "AUTH_IDENTITY_REQUIRED",
        message: "A user identity is required in app-identity mode.",
        retryable: false,
        hint: "Provide user_id/session_id per call or configure getIdentity() in RetainDBClient.",
      });
    }

    return params;
  }

  private async withSessionIdentity<T extends { userId?: string; sessionId?: string }>(params: T): Promise<T> {
    const userId = params.userId ? String(params.userId).trim() : "";
    const sessionId = params.sessionId ? String(params.sessionId).trim() : "";
    if (userId) {
      return {
        ...params,
        userId,
        sessionId: sessionId || params.sessionId,
      };
    }

    const resolved = await this.resolveIdentityOverride();
    if (resolved?.userId) {
      return {
        ...params,
        userId: resolved.userId,
        sessionId: sessionId || resolved.sessionId,
      };
    }

    throw new WhisperError({
      code: "AUTH_IDENTITY_REQUIRED",
      message: "Session operations require a user identity.",
      retryable: false,
      hint: "Pass userId explicitly or configure getIdentity() in RetainDBClient.",
    });
  }

  static fromEnv(overrides: Partial<RetainDBClientConfig> = {}): RetainDBClient {
    const env = (typeof process !== "undefined" ? process.env : {}) as Record<string, string | undefined>;
    const apiKey = overrides.apiKey || env.RETAINDB_API_KEY || env.API_KEY;
    if (!apiKey) {
      throw new WhisperError({
        code: "INVALID_API_KEY",
        message: "Missing API key. Set RETAINDB_API_KEY.",
        retryable: false,
      });
    }
    return new RetainDBClient({
      apiKey,
      baseUrl: overrides.baseUrl || env.RETAINDB_BASE_URL || env.API_BASE_URL || "https://api.retaindb.com",
      project: overrides.project || env.RETAINDB_PROJECT || env.PROJECT,
      identityMode: overrides.identityMode || parseIdentityMode(env.RETAINDB_IDENTITY_MODE),
      environment: overrides.environment || parseEnvironment(env.RETAINDB_ENV || (env.NODE_ENV === "production" ? "production" : "local")),
      strictIdentityMode: overrides.strictIdentityMode ?? env.RETAINDB_DEMO_LOCAL_STRICT === "true",
      ...overrides,
    });
  }

  private createQueueStore(config: WhisperClientConfig) {
    const persistence = config.queue?.persistence || this.defaultQueuePersistence();
    if (persistence === "storage") {
      return createStorageQueueStore();
    }
    if (persistence === "file") {
      const filePath = config.queue?.filePath || this.defaultQueueFilePath();
      if (filePath) {
        return createFileQueueStore(filePath);
      }
    }
    return new InMemoryQueueStore();
  }

  private defaultQueuePersistence(): "memory" | "storage" | "file" {
    const maybeWindow = (globalThis as Record<string, unknown>).window;
    if (maybeWindow && typeof maybeWindow === "object") {
      const maybeStorage = (globalThis as Record<string, unknown>).localStorage;
      return maybeStorage && typeof maybeStorage === "object" ? "storage" : "memory";
    }
    return "file";
  }

  private defaultQueueFilePath(): string | undefined {
    if (typeof process === "undefined") return undefined;
    const path = process.env.RETAINDB_QUEUE_FILE_PATH;
    if (path) return path;
    const home = process.env.USERPROFILE || process.env.HOME;
    if (!home) return undefined;
    const normalizedHome = home.replace(/[\\\/]+$/, "");
    return `${normalizedHome}/.retaindb/sdk/queue.json`;
  }

  private getRequiredProject(project?: string): string {
    return project || this.config.project || DEFAULT_PROJECT_REF;
  }

  private async refreshProjectCache(force = false): Promise<Project[]> {
    if (!force && Date.now() < this.projectCacheExpiresAt && this.projectCache.length > 0) {
      return this.projectCache;
    }

    const response = await this.runtimeClient.request<{ projects?: Project[] }>({
      endpoint: "/v1/projects",
      method: "GET",
      operation: "get",
      idempotent: true,
    });
    this.projectRefToId.clear();
    this.projectCache = response.data?.projects || [];
    for (const project of this.projectCache) {
      this.projectRefToId.set(project.id, project.id);
      this.projectRefToId.set(project.slug, project.id);
      this.projectRefToId.set(project.name, project.id);
    }
    this.projectCacheExpiresAt = Date.now() + PROJECT_CACHE_TTL_MS;
    return this.projectCache;
  }

  private async fetchResolvedProject(projectRef: string): Promise<Project | null> {
    try {
      const response = await this.runtimeClient.request<{ resolved?: Project }>({
        endpoint: `/v1/projects/resolve?project=${encodeURIComponent(projectRef)}`,
        method: "GET",
        operation: "get",
        idempotent: true,
      });
      return response.data?.resolved || null;
    } catch (error) {
      if (error instanceof RuntimeClientError && error.status === 404) {
        return null;
      }
      throw error;
    }
  }

  private async ensureResolvedProject(projectRef: string): Promise<Project | null> {
    const resolvedProject = await this.fetchResolvedProject(projectRef);
    if (resolvedProject || isLikelyProjectId(projectRef)) {
      return resolvedProject;
    }

    try {
      const response = await this.runtimeClient.request<Project>({
        endpoint: "/v1/projects",
        method: "POST",
        operation: "writeAck",
        body: { name: projectRef },
      });
      return response.data;
    } catch (error) {
      const recoveredProject = await this.fetchResolvedProject(projectRef);
      if (recoveredProject) {
        return recoveredProject;
      }
      throw error;
    }
  }

  async resolveProject(projectRef?: string): Promise<Project> {
    return this.runOrThrow(async () => {
      const resolvedRef = this.getRequiredProject(projectRef);
      const cachedProjects = await this.refreshProjectCache(false);
      const cachedProject = cachedProjects.find(
        (project) => project.id === resolvedRef || project.slug === resolvedRef || project.name === resolvedRef,
      );
      if (cachedProject) {
        return cachedProject;
      }

      const resolvedProject = await this.ensureResolvedProject(resolvedRef);
      if (resolvedProject) {
        this.projectRefToId.set(resolvedProject.id, resolvedProject.id);
        this.projectRefToId.set(resolvedProject.slug, resolvedProject.id);
        this.projectRefToId.set(resolvedProject.name, resolvedProject.id);
        this.projectCache = [
          ...this.projectCache.filter((project) => project.id !== resolvedProject.id),
          resolvedProject,
        ];
        this.projectCacheExpiresAt = Date.now() + PROJECT_CACHE_TTL_MS;
        return resolvedProject;
      }

      if (isLikelyProjectId(resolvedRef)) {
        return {
          id: resolvedRef,
          orgId: "",
          name: resolvedRef,
          slug: resolvedRef,
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
        };
      }

      throw new WhisperError({
        code: "PROJECT_NOT_FOUND",
        message: `Project '${resolvedRef}' not found`,
        retryable: false,
      });
    });
  }

  async preflight(options?: { project?: string; requireIdentity?: boolean }): Promise<WhisperPreflightResult> {
    const requestId = randomRequestId();
    const checks: WhisperPreflightCheck[] = [];
    try {
      this.enforceIdentityModeGuardrail(requestId);
    } catch (error) {
      throw this.toWhisperError(error, "Update identity mode before running preflight.");
    }

    const apiKeyOk = typeof this.config.apiKey === "string" && this.config.apiKey.trim().length > 0;
    checks.push({
      check: "api_key",
      ok: apiKeyOk,
      message: apiKeyOk ? "API key is configured." : "Missing API key.",
      hint: apiKeyOk ? undefined : "Set RETAINDB_API_KEY or pass apiKey to RetainDBClient.",
    });

    try {
      await this.runtimeClient.request({
        endpoint: "/v1/projects",
        method: "GET",
        operation: "get",
        idempotent: true,
        traceId: requestId,
      });
      checks.push({
        check: "api_connectivity",
        ok: true,
        message: "Connected to RetainDB API.",
      });
    } catch (error) {
      const mapped = this.toWhisperError(error, "Confirm RETAINDB_BASE_URL and API key permissions.");
      checks.push({
        check: "api_connectivity",
        ok: false,
        message: mapped.message,
        hint: mapped.hint,
      });
    }

      const projectRef = options?.project || this.config.project || DEFAULT_PROJECT_REF;
      if (projectRef) {
        try {
          await this.resolveProject(projectRef);
          checks.push({
            check: "project_access",
            ok: true,
            message: `Project '${projectRef}' is reachable.`,
          });
        } catch (error) {
          const mapped = this.toWhisperError(error, "Create or grant access to the configured project.");
          checks.push({
            check: "project_access",
            ok: false,
            message: mapped.message,
            hint: mapped.hint,
          });
        }
      }

    if (options?.requireIdentity || this.identityMode === "app-identity") {
      try {
        const identity = await this.resolveIdentityOverride();
        const ok = Boolean(identity?.userId);
        checks.push({
          check: "identity_resolution",
          ok,
          message: ok ? "Identity resolver is configured." : "Identity resolver is missing.",
          hint: ok ? undefined : "Provide getIdentity() or pass user_id/session_id per call.",
        });
      } catch (error) {
        const mapped = this.toWhisperError(error, "Fix identity resolver output before production usage.");
        checks.push({
          check: "identity_resolution",
          ok: false,
          message: mapped.message,
          hint: mapped.hint,
        });
      }
    }

    return {
      ok: checks.every((check) => check.ok),
      checks,
      requestId,
      identityMode: this.identityMode,
      environment: this.environment,
    };
  }

  async query(params: QueryInput): Promise<QueryResult> {
    return this.runOrThrow(async () => {
      // strip alias keys so they don't leak into the request body
      const { q, userId, ...rest } = params;
      const normalized: QueryParams = {
        ...rest,
        query: rest.query ?? q ?? "",
        user_id: rest.user_id ?? userId,
        include_memories: rest.include_memories ?? true,
      };
      const identityParams = await this.withIdentity(normalized);
      const project = (await this.resolveProject(identityParams.project)).id;
      const response = await this.runtimeClient.request<QueryResult>({
        endpoint: "/v1/context/query",
        method: "POST",
        operation: "search",
        body: {
          ...identityParams,
          project,
        },
        idempotent: true,
      });
      return response.data;
    });
  }

  /** @deprecated Use db.add(messages, { userId }) instead */
  async remember(params: RememberParams): Promise<LearnResult> {
    if (!params.userId && !this.getIdentity) {
      throw new WhisperError({
        code: "AUTH_IDENTITY_REQUIRED",
        message: "remember() requires userId or a getIdentity() resolver on the client.",
        retryable: false,
        hint: "Pass userId in the call or configure getIdentity() in RetainDBClient.",
      });
    }
    const sessionId =
      params.sessionId ??
      (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `session_${Math.random().toString(36).slice(2, 11)}`);
    return this._learn({
      mode: "conversation",
      project: params.project,
      user_id: params.userId,
      session_id: sessionId,
      messages: params.messages,
    });
  }

  /** @deprecated Use db.ingest(url) instead */
  async _legacyIngest(params: IngestParams): Promise<LearnResult> {
    return this.ingest(params.url, { name: params.name, token: params.token, project: params.project });
  }

  async userProfile(userId: string): Promise<{ user_id: string; memories: unknown[]; count: number }> {
    return this.memory.getUserProfile({ user_id: userId }) as Promise<{ user_id: string; memories: unknown[]; count: number }>;
  }

  async ingestSession(params: {
    project?: string;
    session_id: string;
    user_id?: string;
    agent_id?: string;
    task_id?: string;
    messages: Array<{
      role: string;
      content: string;
      timestamp: string;
    }>;
    events?: SessionWorkEvent[];
    promotion_mode?: PromotionMode;
    async?: boolean;
    write_mode?: "async" | "sync";
  }): Promise<{
    success: boolean;
    memories_created: number;
    relations_created: number;
    memories_invalidated: number;
    errors?: string[];
  } & MemoryWriteAck> {
    return this.runOrThrow(async () => {
      const identityParams = await this.withIdentity(params);
      const project = (await this.resolveProject(identityParams.project)).id;
      const response = await this.runtimeClient.request<{
        success: boolean;
        memories_created: number;
        relations_created: number;
        memories_invalidated: number;
        errors?: string[];
      } & MemoryWriteAck>({
        endpoint: "/v1/memory/ingest/session",
        method: "POST",
        operation: "session",
        body: {
          ...identityParams,
          project,
        },
      });
      return response.data;
    });
  }

  async learn(params: LearnInput): Promise<LearnResult> {
    return this._learn(params);
  }

  /**
   * Background learning — called automatically by add() and from().
   * Not intended for direct use; use add() or from() instead.
   */
  private async _learn(params: LearnInput): Promise<LearnResult> {
    return this.runOrThrow(async () => {
      const identityParams =
        params.mode === "conversation"
          ? await this.withIdentity(params as LearnInput & { user_id?: string; session_id?: string })
          : params;
      const project = (await this.resolveProject(identityParams.project)).id;
      const response = await this.runtimeClient.request<LearnResult>({
        endpoint: "/v1/learn",
        method: "POST",
        operation: params.mode === "conversation" ? "session" : "bulk",
        body: {
          ...identityParams,
          project,
        },
      });
      return response.data;
    });
  }

  /**
   * Store a memory or dump a conversation for background extraction.
   *
   * - Pass a **string** to write a direct memory: `db.add("User prefers dark mode", { userId })`
   * - Pass a **messages array** to dump a conversation — memory extraction runs automatically
   *   in the background (fire-and-forget): `db.add([{ role: "user", content: "..." }, ...], { userId })`
   */
  async add(
    content: string | Array<{ role: string; content: string; timestamp?: string }>,
    options?: AddOptions,
  ): Promise<MemoryWriteAck> {
    if (Array.isArray(content)) {
      if (!options?.userId && !this.getIdentity) {
        throw new WhisperError({
          code: "AUTH_IDENTITY_REQUIRED",
          message: "add() with messages requires userId or a getIdentity() resolver.",
          retryable: false,
          hint: "Pass userId in options or configure getIdentity() in RetainDBClient.",
        });
      }
      const sessionId =
        options?.sessionId ??
        (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : `session_${Math.random().toString(36).slice(2, 11)}`);
      // Fire-and-forget — extraction happens in the background.
      // Errors are swallowed intentionally; use diagnostics for visibility.
      void this._learn({
        mode: "conversation",
        project: options?.project,
        user_id: options?.userId,
        agent_id: options?.agentId,
        task_id: options?.taskId,
        session_id: sessionId,
        messages: content,
        promotion_mode: options?.promotionMode,
      }).catch((err) => {
        console.warn("[RetainDB] Background learning failed (non-blocking):", err?.message ?? err);
      });
      return { success: true, mode: "async", queued: true };
    }
    return this.memory.add({
      content,
      user_id: options?.userId,
      session_id: options?.sessionId,
      agent_id: options?.agentId,
      task_id: options?.taskId,
      project: options?.project,
      memory_type: options?.type,
      scope_target: options?.scopeTarget,
      promotion_mode: options?.promotionMode,
      importance: options?.importance,
      metadata: options?.metadata,
    });
  }

  /**
   * Search memories and return a context string ready for prompt injection.
   *
   * ```ts
   * const { context } = await db.search("user preferences", { userId });
   * // inject `context` into your system prompt
   * ```
   */
  async search(query: string, options?: SearchOptions): Promise<SearchResult> {
    return this.runOrThrow(async () => {
      const result = await this.query({
        query,
        project: options?.project,
        user_id: options?.userId,
        session_id: options?.sessionId,
        agent_id: options?.agentId,
        top_k: options?.topK,
        include_memories: true,
        // map quality to internal profile
        ...(options?.quality === "fast" ? { retrieval_profile: "legacy" } : {}),
        ...(options?.quality === "quality" ? { rerank: true } : {}),
      });
      return {
        context: result.context || "",
        memories: (result.results || []).map((r) => ({
          id: r.id,
          content: r.content,
          score: r.score,
          type: r.type,
          createdAt: r.metadata?.created_at as string | undefined,
        })),
        cached: false,
      };
    });
  }

  /**
   * Ingest a source — GitHub repo, PDF, website, or video.
   * Learning happens automatically in the background.
   *
   * ```ts
   * await db.ingest("https://github.com/org/repo")
   * await db.ingest("https://example.com/docs")
   * await db.ingest("https://example.com/paper.pdf")
   * ```
   */
  async ingest(url: string, options?: FromOptions): Promise<LearnResult> {
    const detected = detectSourceType(url);
    return this._learn({
      mode: "source",
      project: options?.project,
      type: detected.type,
      url,
      name: options?.name,
      token: options?.token,
      ...(detected.owner ? { owner: detected.owner } : {}),
      ...(detected.repo ? { repo: detected.repo } : {}),
    });
  }

  /** @deprecated Use db.ingest(url) instead */
  async from(url: string, options?: FromOptions): Promise<LearnResult> {
    return this.ingest(url, options);
  }

  createAgentRuntime(options: AgentRuntimeOptions = {}): WhisperAgentRuntime { // WhisperAgentRuntime rename tracked separately
    const baseContext: AgentRunContext = {
      workspacePath: options.workspacePath,
      project: options.project || this.config.project,
      userId: options.userId,
      sessionId: options.sessionId,
      agentId: options.agentId,
      taskId: options.taskId,
      traceId: options.traceId,
      clientName: options.clientName,
    };

    return new WhisperAgentRuntime({
      baseContext,
      options,
      adapter: {
        resolveProject: (project) => this.resolveProject(project),
        query: (params) => this.query(params),
        ingestSession: (params) => this.ingestSession(params),
        getSessionMemories: (params) => this.memory.getSessionMemories(params),
        getUserProfile: (params) => this.memory.getUserProfile(params),
        searchMemories: (params) => this.memory.search(params),
        addMemory: (params) => this.memory.add(params),
        queueStatus: () => this.queue.status(),
        flushQueue: () => this.queue.flush(),
      },
    });
  }

  withRunContext(context: RunContext) {
    const base = this;
    return {
      memory: {
        add: (params: Omit<Parameters<MemoryModule["add"]>[0], "project" | "user_id" | "session_id"> & { project?: string; user_id?: string; session_id?: string; memory_type?: MemoryKind }) =>
          base.memory.add({
            ...params,
            project: params.project || context.project || base.config.project,
            user_id: params.user_id || context.userId,
            session_id: params.session_id || context.sessionId,
            agent_id: params.agent_id || context.agentId,
            task_id: params.task_id || context.taskId,
          }),
        search: (params: Omit<Parameters<MemoryModule["search"]>[0], "project" | "user_id" | "session_id"> & { project?: string; user_id?: string; session_id?: string }) =>
          base.memory.search({
            ...params,
            project: params.project || context.project || base.config.project,
            user_id: params.user_id || context.userId,
            session_id: params.session_id || context.sessionId,
            agent_id: params.agent_id || context.agentId,
            task_id: params.task_id || context.taskId,
          }),
      },
      session: {
        event: (params: Omit<Parameters<SessionModule["event"]>[0], "sessionId"> & { sessionId?: string }) =>
          base.session.event({
            ...params,
            sessionId: params.sessionId || context.sessionId || "",
          }),
      },
      add: (
        content: string | Array<{ role: string; content: string; timestamp?: string }>,
        options?: AddOptions,
      ) =>
        base.add(content, {
          ...options,
          project: options?.project || context.project || base.config.project,
          userId: options?.userId || context.userId,
          sessionId: options?.sessionId || context.sessionId,
          agentId: options?.agentId || context.agentId,
          taskId: options?.taskId || context.taskId,
        }),
      search: (query: string, options?: SearchOptions) =>
        base.search(query, {
          ...options,
          project: options?.project || context.project || base.config.project,
          userId: options?.userId || context.userId,
          sessionId: options?.sessionId || context.sessionId,
          agentId: options?.agentId || context.agentId,
          taskId: options?.taskId || context.taskId,
        }),
      ingest: (url: string, options?: FromOptions) =>
        base.ingest(url, {
          ...options,
          project: options?.project || context.project || base.config.project,
        }),
      queue: base.queue,
      diagnostics: base.diagnostics,
    };
  }

  async deleteSource(sourceId: string): Promise<{ deleted: boolean; id: string; restore_until: string }> {
    return this.runOrThrow(async () => {
      const response = await this.runtimeClient.request<{ deleted: boolean; id: string; restore_until: string }>({
        endpoint: `/v1/sources/${sourceId}`,
        method: "DELETE",
        operation: "writeAck",
      });
      return response.data;
    });
  }

  async extractMemories(params: { project: string; message: string }): Promise<{ explicit: unknown[]; implicit: unknown[]; all: unknown[] }> {
    return this.runOrThrow(async () => {
      const project = (await this.resolveProject(params.project)).id;
      const response = await this.runtimeClient.request<{ explicit: unknown[]; implicit: unknown[]; all: unknown[] }>({
        endpoint: "/v1/memory/extract",
        method: "POST",
        operation: "writeAck",
        body: { project, message: params.message },
      });
      return response.data;
    });
  }

  async shutdown(): Promise<void> {
    await this.writeQueue.stop();
  }
}

export default RetainDBClient;

// Deprecated alias — type aliases are declared inline above
export { RetainDBClient as WhisperClient };
