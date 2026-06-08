/**
 * RetainDB SDK
 * TypeScript SDK for the RetainDB Context API
 */
import { RuntimeClient, RuntimeClientError } from "./core/client.js";
import {
  RetainDBError,
  type RetainDBErrorCode,
} from "./errors.js";
import type { LearnInput, LearnResult, LearnSourceResult } from "./modules/types.js";

export interface RetainDBConfig {
  apiKey: string;
  baseUrl?: string;
  project?: string;
  timeoutMs?: number;
  retry?: {
    maxAttempts?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
  };
}

export interface QueryParams {
  project?: string;
  query: string;
  top_k?: number;
  threshold?: number;
  chunk_types?: string[];
  source_ids?: string[];
  metadata_filter?: Record<string, any>;
  hybrid?: boolean;
  vector_weight?: number;
  bm25_weight?: number;
  rerank?: boolean;
  include_memories?: boolean;
  include_pending?: boolean;
  user_id?: string;
  session_id?: string;
  agent_id?: string;
  include_graph?: boolean;
  graph_depth?: number;
  max_tokens?: number;
  compress?: boolean;
  compression_strategy?: "summarize" | "extract" | "delta" | "adaptive";
  use_cache?: boolean;
  include_parent_content?: boolean;
  retrieval_profile?: "legacy" | "precision_v1" | "fast" | "balanced" | "vector" | "lexical" | string;
}

export interface QueryResult {
  results: Array<{
    id: string;
    content: string;
    score: number;
    metadata: Record<string, any>;
    source: string;
    document: string;
    type: string;
    retrieval_source: string;
  }>;
  context: string;
  meta: {
    query: string;
    total: number;
    latency_ms: number;
    cache_hit: boolean;
    tokens_used: number;
    context_hash: string;
    source_scope?: {
      mode: "none" | "explicit" | "auto";
      source_ids: string[];
      host?: string;
      matched_sources?: number;
    };
    profile?: string;
    retrieval_profile?: "legacy" | "precision_v1" | "fast" | "balanced" | "vector" | "lexical" | string;
    compression?: any;
    timing?: {
      cache_check_ms?: number;
      embed_ms?: number;
      vector_ms?: number;
      fts_ms?: number;
      rerank_ms?: number;
      enrich_ms?: number;
      pack_ms?: number;
      cache_set_ms?: number;
      total_ms?: number;
      [key: string]: number | undefined;
    };
  };
}

export interface ContextFilesystemParams {
  project?: string;
  path?: string;
  includeContents?: boolean;
  include_contents?: boolean;
  limit?: number;
}

export interface ContextFilesystemEntry {
  path: string;
  name: string;
  type: "file" | "directory";
  title?: string;
  parent?: string | null;
  mimeType?: string;
  size?: number;
  updatedAt?: string;
  metadata?: Record<string, any>;
  content?: string;
  children?: ContextFilesystemEntry[];
}

export interface ContextFilesystemResult {
  projectId: string;
  generatedAt: string;
  root: string;
  requestedPath: string;
  tree: ContextFilesystemEntry[];
  read: ContextFilesystemEntry | null;
  directory: (ContextFilesystemEntry & { children?: ContextFilesystemEntry[] }) | null;
  stats: {
    directories: number;
    files: number;
    sources: number;
    documents: number;
    memories: number;
    recentQueries: number;
  };
}

export interface Project {
  id: string;
  orgId: string;
  name: string;
  slug: string;
  description?: string;
  settings?: Record<string, any>;
  createdAt: string;
  updatedAt: string;
}

export interface Source {
  id: string;
  projectId: string;
  name: string;
  connectorType: string;
  config: Record<string, any>;
  status: string;
  syncSchedule?: string;
  lastSyncAt?: string;
  syncError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface VideoSourceMetadata {
  source_kind: "video";
  video_url: string;
  platform: "youtube" | "loom" | "generic";
  duration_seconds?: number;
  published_at?: string;
  channel_or_author?: string;
}

export interface VideoIngestionStatus {
  source_id: string;
  status: string;
  stage: "extracting" | "transcribing" | "segmenting" | "enriching" | "indexing" | "completed" | "failed";
  sync_job_id?: string | null;
  progress?: {
    current: number;
    total: number;
    message: string;
  } | null;
  duration_seconds?: number | null;
  chunks_indexed?: number | null;
  decisions_detected?: number | null;
  entities_extracted?: string[];
  last_error?: string | null;
  updated_at?: string;
}

export type CanonicalSourceType = "github" | "web" | "playwright" | "pdf" | "local" | "slack" | "video";

export interface CanonicalSourceCreateParams {
  type: CanonicalSourceType;
  name?: string;
  auto_index?: boolean;
  metadata?: Record<string, string>;
  ingestion_profile?: "auto" | "repo" | "web_docs" | "pdf_layout" | "video_transcript" | "plain_text";
  strategy_override?: "fixed" | "recursive" | "semantic" | "hierarchical" | "adaptive";
  profile_config?: Record<string, any>;
  owner?: string;
  repo?: string;
  branch?: string;
  paths?: string[];
  url?: string;
  crawl_depth?: number;
  include_paths?: string[];
  exclude_paths?: string[];
  file_path?: string;
  path?: string;
  glob?: string;
  max_files?: number;
  max_pages?: number;
  extract_mode?: "text" | "structured" | "markdown";
  workspace_id?: string;
  channel_ids?: string[];
  since?: string;
  token?: string;
  auth_ref?: string;
  platform?: "youtube" | "loom" | "generic";
  language?: string;
  allow_stt_fallback?: boolean;
  max_duration_minutes?: number;
  max_chunks?: number;
}

export interface CanonicalSourceCreateResult {
  source_id: string;
  status: "queued" | "indexing" | "ready" | "failed";
  job_id: string | null;
  index_started: boolean;
  warnings: string[];
}

export interface Memory {
  id: string;
  projectId: string;
  content: string;
  memoryType: "factual" | "episodic" | "semantic" | "procedural";
  userId?: string;
  sessionId?: string;
  agentId?: string;
  importance: number;
  metadata: Record<string, any>;
  accessCount: number;
  createdAt: string;
  updatedAt: string;
}

export type MemoryKind =
  | "factual"
  | "preference"
  | "event"
  | "relationship"
  | "opinion"
  | "goal"
  | "instruction"
  | "decision"
  | "constraint"
  | "solution"
  | "project_state"
  | "correction"
  | "workflow";

export type MemoryScopeTarget =
  | "USER"
  | "SESSION"
  | "PROJECT"
  | "AGENT"
  | "TASK"
  | "DOCUMENT";

export type PromotionMode = "session_state_v1" | "user_specific_legacy";

export interface SessionWorkEvent {
  kind: "decision" | "constraint" | "outcome" | "failure" | "task_update" | "file_edit" | "tool_result";
  summary: string;
  details?: string;
  salience?: "low" | "medium" | "high";
  timestamp?: string;
  filePaths?: string[];
  toolName?: string;
  success?: boolean;
}

export interface ExtractedMemory {
  content: string;
  memoryType: MemoryKind;
  entityMentions: string[];
  eventDate: string | null;
  confidence: number;
  reasoning?: string;
  inferred?: boolean;
  sourceRole?: "user" | "assistant" | "event" | "document" | "system";
  userConfirmed?: boolean;
  supportingEvent?: boolean;
}

export interface MemoryExtractionResult {
  explicit: ExtractedMemory[];
  implicit: ExtractedMemory[];
  all: ExtractedMemory[];
  extractionMethod: "pattern" | "inference" | "hybrid" | "skipped";
  latencyMs: number;
}

export interface MemoryLatencyBreakdown {
  cache_ms: number;
  embed_ms: number;
  vector_ms: number;
  lexical_ms: number;
  merge_ms: number;
  total_ms: number;
}

export interface MemorySearchResponse {
  results: Array<{
    memory: {
      id: string;
      content: string;
      type: string;
      entities?: string[];
      confidence?: number;
      version?: number;
      scope?: string;
      scope_target?: MemoryScopeTarget;
      user_id?: string | null;
      session_id?: string | null;
      agent_id?: string | null;
      task_id?: string | null;
      temporal?: {
        document_date?: string | null;
        event_date?: string | null;
        valid_from?: string | null;
        valid_until?: string | null;
      };
    };
    chunk?: {
      id: string;
      content: string;
      metadata?: Record<string, any>;
    };
    similarity: number;
    relations?: any[];
  }>;
  count: number;
  query: string;
  trace_id?: string;
  question_date?: string;
  latency_ms?: number;
  latency_breakdown?: MemoryLatencyBreakdown;
  fallback?: "vector" | "lexical";
  mode?: "fast" | "balanced" | "quality";
  profile?: "fast" | "balanced" | "quality";
  include_pending?: boolean;
  pending_overlay_count?: number;
  scope_counts?: Partial<Record<MemoryScopeTarget, number>>;
  scopes_touched?: MemoryScopeTarget[];
}

export interface MemoryWriteAck {
  success: boolean;
  mode?: "async" | "sync";
  trace_id?: string;
  job_id?: string;
  status_url?: string;
  accepted_at?: string;
  visibility_sla_ms?: number;
  pending_visibility?: boolean;
  [key: string]: any;
}

export interface MemoryWriteResult {
  id: string;
  success: boolean;
  path: "sota" | "legacy";
  fallback_used: boolean;
  mode?: "async" | "sync";
  memory_id?: string;
  job_id?: string;
  status_url?: string;
  accepted_at?: string;
  visibility_sla_ms?: number;
  pending_visibility?: boolean;
  semantic_status?: "pending" | "ready";
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 250;
const DEFAULT_MAX_DELAY_MS = 2_000;
const DEFAULT_TIMEOUT_MS = 15_000;
const PROJECT_CACHE_TTL_MS = 30_000;
const DEFAULT_PROJECT_REF = "default";
const DEPRECATION_WARNINGS = new Set<string>();

function warnDeprecatedOnce(key: string, message: string): void {
  if (DEPRECATION_WARNINGS.has(key)) return;
  DEPRECATION_WARNINGS.add(key);
  if (typeof console !== "undefined" && typeof console.warn === "function") {
    console.warn(message);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getBackoffDelay(attempt: number, base: number, max: number): number {
  const jitter = 0.8 + Math.random() * 0.4;
  return Math.min(max, Math.floor(base * Math.pow(2, attempt) * jitter));
}

function isLikelyProjectId(projectRef: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(projectRef);
}

function normalizeBaseUrl(url: string): string {
  let normalized = url.trim().replace(/\/+$/, "");
  normalized = normalized.replace(/\/api\/v1$/i, "");
  normalized = normalized.replace(/\/v1$/i, "");
  normalized = normalized.replace(/\/api$/i, "");
  return normalized;
}

function normalizeEndpoint(endpoint: string): string {
  const withLeadingSlash = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
  if (/^\/api\/v1(\/|$)/i.test(withLeadingSlash)) {
    return withLeadingSlash.replace(/^\/api/i, "");
  }
  return withLeadingSlash;
}

function isProjectNotFoundMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("project not found") ||
    normalized.includes("no project found") ||
    normalized.includes("project does not exist")
  );
}

export class RetainDBContext {
  private apiKey: string;
  private baseUrl: string;
  private defaultProject?: string;
  private timeoutMs: number;
  private retryConfig: Required<NonNullable<RetainDBConfig["retry"]>>;
  private runtimeClient: RuntimeClient;

  private projectRefToId = new Map<string, string>();
  private projectCache: Project[] = [];
  private projectCacheExpiresAt = 0;

  constructor(config: RetainDBConfig) {
    const baseUrl = normalizeBaseUrl(config.baseUrl || "https://api.retaindb.com");
    if (!config.apiKey) {
      const isLocal = /localhost|127\.0\.0\.1|0\.0\.0\.0/i.test(baseUrl);
      if (!isLocal) {
        throw new RetainDBError({
          code: "INVALID_API_KEY",
          message: "API key is required for non-local servers. For a local server, pass apiKey: \"local-no-auth\" or set RETAINDB_KEY=local-no-auth.",
        });
      }
    }

    this.apiKey = config.apiKey || "local-no-auth";
    this.baseUrl = baseUrl;
    this.defaultProject = config.project;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retryConfig = {
      maxAttempts: config.retry?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      baseDelayMs: config.retry?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS,
      maxDelayMs: config.retry?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS,
    };
    this.runtimeClient = new RuntimeClient({
      apiKey: this.apiKey,
      baseUrl: this.baseUrl,
      compatMode: "fallback",
      timeouts: {
        searchMs: this.timeoutMs,
        writeAckMs: this.timeoutMs,
        bulkMs: Math.max(this.timeoutMs, 10000),
        profileMs: this.timeoutMs,
        sessionMs: this.timeoutMs,
      },
      retryPolicy: {
        baseBackoffMs: this.retryConfig.baseDelayMs,
        maxBackoffMs: this.retryConfig.maxDelayMs,
        maxAttemptsByOperation: {
          search: this.retryConfig.maxAttempts,
          writeAck: this.retryConfig.maxAttempts,
          bulk: this.retryConfig.maxAttempts,
          profile: this.retryConfig.maxAttempts,
          session: this.retryConfig.maxAttempts,
          query: this.retryConfig.maxAttempts,
          get: this.retryConfig.maxAttempts,
        },
      },
    });
    warnDeprecatedOnce(
      "whisper_context_class",
      "[RetainDB SDK] RetainDBContext is deprecated in v3 and scheduled for removal in v4. Prefer RetainDBClient for runtime features and future contract compatibility."
    );
  }

  withProject(project: string): RetainDBContext {
    return new RetainDBContext({
      apiKey: this.apiKey,
      baseUrl: this.baseUrl,
      project,
      timeoutMs: this.timeoutMs,
      retry: this.retryConfig,
    });
  }

  private getRequiredProject(project?: string): string {
    return project || this.defaultProject || DEFAULT_PROJECT_REF;
  }

  private async refreshProjectCache(force = false): Promise<Project[]> {
    if (!force && Date.now() < this.projectCacheExpiresAt && this.projectCache.length > 0) {
      return this.projectCache;
    }

    const response = await this.request<{ projects: Project[] }>("/v1/projects", { method: "GET" });
    this.projectRefToId.clear();
    this.projectCache = response.projects || [];

    for (const p of this.projectCache) {
      this.projectRefToId.set(p.id, p.id);
      this.projectRefToId.set(p.slug, p.id);
      this.projectRefToId.set(p.name, p.id);
    }

    if (this.defaultProject) {
      const hasDefaultProject = this.projectCache.some(
        (project) =>
          project.id === this.defaultProject
          || project.slug === this.defaultProject
          || project.name === this.defaultProject
      );
      if (!hasDefaultProject) {
        const resolvedDefault = await this.fetchResolvedProject(this.defaultProject);
        if (resolvedDefault) {
          this.projectCache = [...this.projectCache, resolvedDefault];
          this.projectRefToId.set(resolvedDefault.id, resolvedDefault.id);
          this.projectRefToId.set(resolvedDefault.slug, resolvedDefault.id);
          this.projectRefToId.set(resolvedDefault.name, resolvedDefault.id);
        }
      }
    }

    this.projectCacheExpiresAt = Date.now() + PROJECT_CACHE_TTL_MS;
    return this.projectCache;
  }

  private async fetchResolvedProject(projectRef: string): Promise<Project | null> {
    if (!projectRef) return null;
    try {
      const response = await this.request<{
        resolved: Project;
      }>(`/v1/projects/resolve?project=${encodeURIComponent(projectRef)}`, { method: "GET" });
      return response?.resolved || null;
    } catch (error) {
      if (error instanceof RetainDBError && error.code === "PROJECT_NOT_FOUND") {
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
      return await this.createProject({ name: projectRef });
    } catch (error) {
      const recoveredProject = await this.fetchResolvedProject(projectRef);
      if (recoveredProject) {
        return recoveredProject;
      }
      throw error;
    }
  }

  async resolveProject(projectRef?: string): Promise<Project> {
    const resolvedRef = this.getRequiredProject(projectRef);
    const cachedProjects = await this.refreshProjectCache(false);
    const cachedProject = cachedProjects.find(
      (project) =>
        project.id === resolvedRef
        || project.slug === resolvedRef
        || project.name === resolvedRef
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

    throw new RetainDBError({
      code: "PROJECT_NOT_FOUND",
      message: `Project '${resolvedRef}' not found`,
    });
  }

  private async resolveProjectId(projectRef: string): Promise<string> {
    if (this.projectRefToId.has(projectRef)) {
      return this.projectRefToId.get(projectRef)!;
    }

    const projects = await this.refreshProjectCache(true);

    const byDirect = projects.find((p) => p.id === projectRef);
    if (byDirect) return byDirect.id;

    const matches = projects.filter((p) => p.slug === projectRef || p.name === projectRef);

    if (matches.length === 1) {
      return matches[0].id;
    }

    if (matches.length > 1) {
      throw new RetainDBError({
        code: "PROJECT_AMBIGUOUS",
        message: `Project reference '${projectRef}' matched multiple projects. Use project id instead.`,
      });
    }

    if (isLikelyProjectId(projectRef)) {
      return projectRef;
    }

    const resolvedProject = await this.ensureResolvedProject(projectRef);
    if (resolvedProject) {
      this.projectRefToId.set(resolvedProject.id, resolvedProject.id);
      this.projectRefToId.set(resolvedProject.slug, resolvedProject.id);
      this.projectRefToId.set(resolvedProject.name, resolvedProject.id);
      this.projectCache = [
        ...this.projectCache.filter((project) => project.id !== resolvedProject.id),
        resolvedProject,
      ];
      this.projectCacheExpiresAt = Date.now() + PROJECT_CACHE_TTL_MS;
      return resolvedProject.id;
    }

    throw new RetainDBError({
      code: "PROJECT_NOT_FOUND",
      message: `Project '${projectRef}' not found`,
    });
  }

  private async getProjectRefCandidates(projectRef: string): Promise<string[]> {
    const candidates = new Set<string>([projectRef]);

    try {
      const projects = await this.refreshProjectCache(false);
      const match = projects.find((p) => p.id === projectRef || p.slug === projectRef || p.name === projectRef);
      if (match) {
        candidates.add(match.id);
        candidates.add(match.slug);
        candidates.add(match.name);
      } else if (isLikelyProjectId(projectRef)) {
        const byId = projects.find((p) => p.id === projectRef);
        if (byId) {
          candidates.add(byId.slug);
          candidates.add(byId.name);
        }
      }
    } catch {
      // Keep original project reference if listing projects fails.
    }

    return Array.from(candidates).filter(Boolean);
  }

  private async withProjectRefFallback<T>(
    projectRef: string,
    execute: (project: string) => Promise<T>
  ): Promise<T> {
    // Fast path: avoid a projects-list roundtrip unless the provided ref fails.
    try {
      return await execute(projectRef);
    } catch (error) {
      if (!(error instanceof RetainDBError) || error.code !== "PROJECT_NOT_FOUND") {
        throw error;
      }
    }

    const refs = await this.getProjectRefCandidates(projectRef);
    let lastError: unknown;

    for (const ref of refs) {
      if (ref === projectRef) continue;
      try {
        return await execute(ref);
      } catch (error) {
        lastError = error;
        if (error instanceof RetainDBError && error.code === "PROJECT_NOT_FOUND") {
          continue;
        }
        throw error;
      }
    }

    if (lastError instanceof Error) {
      throw lastError;
    }

    throw new RetainDBError({
      code: "PROJECT_NOT_FOUND",
      message: `Project '${projectRef}' not found`,
    });
  }

  private shouldRetryWithResolvedProjectId(error: unknown): boolean {
    return error instanceof RetainDBError
      && error.status === 404
      && !this.isEndpointNotFoundError(error);
  }

  private async withProjectPathFallback<T>(
    projectRef: string,
    execute: (projectPathRef: string) => Promise<T>
  ): Promise<T> {
    try {
      return await execute(projectRef);
    } catch (error) {
      if (!this.shouldRetryWithResolvedProjectId(error)) {
        throw error;
      }
    }

    const resolvedProjectId = await this.resolveProjectId(projectRef);
    if (resolvedProjectId === projectRef) {
      throw new RetainDBError({
        code: "PROJECT_NOT_FOUND",
        message: `Project '${projectRef}' not found`,
      });
    }
    return execute(resolvedProjectId);
  }

  private classifyError(status: number | undefined, message: string): { code: RetainDBErrorCode; retryable: boolean } {
    if (status === 401 || /api key|unauthorized|forbidden/i.test(message)) {
      return { code: "INVALID_API_KEY", retryable: false };
    }
    if (status === 404 && isProjectNotFoundMessage(message)) {
      return { code: "PROJECT_NOT_FOUND", retryable: false };
    }
    if (status === 408) {
      return { code: "TIMEOUT", retryable: true };
    }
    if (status === 429) {
      return { code: "RATE_LIMITED", retryable: true };
    }
    if (status !== undefined && status >= 500) {
      return { code: "TEMPORARY_UNAVAILABLE", retryable: true };
    }
    return { code: "REQUEST_FAILED", retryable: false };
  }

  private isEndpointNotFoundError(error: unknown): boolean {
    if (!(error instanceof RetainDBError)) {
      return false;
    }
    if (error.status !== 404) {
      return false;
    }
    const message = (error.message || "").toLowerCase();
    return !isProjectNotFoundMessage(message);
  }

  private inferOperation(endpoint: string, method: string): "search" | "writeAck" | "bulk" | "profile" | "session" | "query" | "get" {
    const normalized = normalizeEndpoint(endpoint).toLowerCase();
    if (normalized.includes("/memory/search")) return "search";
    if (normalized.includes("/memory/bulk")) return "bulk";
    if (normalized.includes("/memory/profile") || normalized.includes("/memory/session")) return "profile";
    if (normalized.includes("/memory/ingest/session")) return "session";
    if (normalized.includes("/context")) return "query";
    if (method === "GET") return "get";
    return "writeAck";
  }

  private async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const method = String(options.method || "GET").toUpperCase();
    const normalizedEndpoint = normalizeEndpoint(endpoint);
    const operation = this.inferOperation(normalizedEndpoint, method);
    let body: Record<string, unknown> | undefined;
    if (typeof options.body === "string") {
      try {
        body = JSON.parse(options.body) as Record<string, unknown>;
      } catch {
        body = undefined;
      }
    } else if (
      options.body &&
      typeof options.body === "object" &&
      !ArrayBuffer.isView(options.body) &&
      !(options.body instanceof ArrayBuffer) &&
      !(options.body instanceof FormData) &&
      !(options.body instanceof URLSearchParams) &&
      !(options.body instanceof Blob) &&
      !(options.body instanceof ReadableStream)
    ) {
      body = options.body as unknown as Record<string, unknown>;
    }

    try {
      const response = await this.runtimeClient.request<T>({
        endpoint: normalizedEndpoint,
        method: method as "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
        operation,
        idempotent: method === "GET" || method === "POST" && (operation === "search" || operation === "query" || operation === "profile"),
        body,
        headers: (options.headers || {}) as Record<string, string>,
      });
      return response.data;
    } catch (error: unknown) {
      if (!(error instanceof RuntimeClientError)) {
        throw error;
      }
      let message = error.message;
      if (error.status === 404 && !isProjectNotFoundMessage(message)) {
        const endpointHint = `${this.baseUrl}${normalizedEndpoint}`;
        message = `Endpoint not found at ${endpointHint}. This deployment may not support this API route.`;
      }
      const { code, retryable } = this.classifyError(error.status, message);
      throw new RetainDBError({
        code,
        message,
        status: error.status,
        retryable,
        hint: error.hint,
        requestId: error.requestId || error.traceId,
        details: error.details,
        cause: error,
      });
    }
  }

  async query(params: QueryParams): Promise<QueryResult> {
    const projectRef = this.getRequiredProject(params.project);
    return this.withProjectRefFallback(projectRef, (project) => this.request<QueryResult>("/v1/context/query", {
      method: "POST",
      body: JSON.stringify({ ...params, project }),
    }));
  }

  async readContextFile(params: ContextFilesystemParams = {}): Promise<ContextFilesystemResult> {
    const projectRef = this.getRequiredProject(params.project);
    return this.withProjectRefFallback(projectRef, async (project) => {
      try {
        return await this.request<ContextFilesystemResult>("/v1/context/files", {
          method: "POST",
          body: JSON.stringify({ ...params, project }),
        });
      } catch (error) {
        if (!this.isEndpointNotFoundError(error)) {
          throw error;
        }
        const query = new URLSearchParams({
          project,
          ...params.path ? { path: params.path } : {},
          ...params.includeContents !== void 0 ? { includeContents: String(params.includeContents) } : {},
          ...params.include_contents !== void 0 ? { include_contents: String(params.include_contents) } : {},
          ...params.limit !== void 0 ? { limit: String(params.limit) } : {},
        });
        const local = await this.request<any>(`/v1/context/files?${query}`, { method: "GET" });
        return this.normalizeContextFilesystemResult(local, project, params.path);
      }
    });
  }

  private normalizeContextFilesystemResult(value: any, project: string, requestedPath?: string): any {
    if (value?.projectId && Array.isArray(value?.tree)) return value;
    const rawFiles = Array.isArray(value?.tree) ? value.tree : Array.isArray(value?.files) ? value.files : [];
    const tree = rawFiles.map((e: any) => ({
      path: String(e?.path || ""),
      type: e?.type === "directory" ? "directory" : "file",
      bytes: typeof e?.bytes === "number" ? e.bytes : undefined,
      updatedAt: e?.updatedAt ? String(e.updatedAt) : undefined,
    }));
    const entryFor = (e: any) => e ? ({
      path: String(e?.path || ""),
      type: e?.type === "directory" ? "directory" : "file",
      bytes: typeof e?.bytes === "number" ? e.bytes : undefined,
      updatedAt: e?.updatedAt ? String(e.updatedAt) : undefined,
      content: typeof e?.content === "string" ? e.content : undefined,
    }) : null;
    const read = value?.read ? entryFor(value.read) : value?.file ? entryFor(value.file) : null;
    const directory = value?.directory ? entryFor(value.directory) : null;
    return {
      projectId: project,
      generatedAt: value?.generatedAt || new Date().toISOString(),
      root: String(value?.root || "/"),
      requestedPath: String(value?.requestedPath || requestedPath || value?.file?.path || "/"),
      tree,
      read,
      directory,
      stats: value?.stats || {
        directories: tree.filter((e: any) => e.type === "directory").length,
        files: tree.filter((e: any) => e.type === "file").length + (read ? 1 : 0),
        sources: 0, documents: 0, memories: 0, recentQueries: 0,
      },
    };
  }

  async createProject(params: {
    name: string;
    description?: string;
    settings?: Record<string, any>;
  }): Promise<Project> {
    const project = await this.request<Project>("/v1/projects", {
      method: "POST",
      body: JSON.stringify(params),
    });

    this.projectRefToId.set(project.id, project.id);
    this.projectRefToId.set(project.slug, project.id);
    this.projectRefToId.set(project.name, project.id);
    this.projectCache = [
      ...this.projectCache.filter((p) => p.id !== project.id),
      project,
    ];
    this.projectCacheExpiresAt = Date.now() + PROJECT_CACHE_TTL_MS;

    return project;
  }

  async listProjects(): Promise<{ projects: Project[] }> {
    const projects = await this.request<{ projects: Project[] }>("/v1/projects", { method: "GET" });
    this.projectCache = projects.projects || [];
    for (const p of projects.projects || []) {
      this.projectRefToId.set(p.id, p.id);
      this.projectRefToId.set(p.slug, p.id);
      this.projectRefToId.set(p.name, p.id);
    }
    this.projectCacheExpiresAt = Date.now() + PROJECT_CACHE_TTL_MS;
    return projects;
  }

  async getProject(id: string): Promise<Project & { sources: Source[] }> {
    return this.withProjectPathFallback(this.getRequiredProject(id), (projectPathRef) =>
      this.request<Project & { sources: Source[] }>(`/v1/projects/${encodeURIComponent(projectPathRef)}`)
    );
  }

  async listSources(project?: string): Promise<{
    project: { id: string; name: string; slug: string };
    sources: Source[];
  }> {
    const projectRef = this.getRequiredProject(project);
    return this.withProjectRefFallback(projectRef, (resolvedProject) =>
      this.request(`/v1/sources?project=${encodeURIComponent(resolvedProject)}`, { method: "GET" })
    );
  }

  async deleteProject(id: string): Promise<{ deleted: boolean }> {
    const projectId = await this.resolveProjectId(id);
    return this.request<{ deleted: boolean }>(`/v1/projects/${projectId}`, { method: "DELETE" });
  }

  async addSource(
    projectId: string,
    params: {
      name: string;
      connector_type: string;
      config: Record<string, any>;
      sync_schedule?: string;
    }
  ): Promise<Source> {
    return this.withProjectPathFallback(this.getRequiredProject(projectId), async (projectPathRef) => {
      const created = await this.request<any>(`/v1/sources`, {
        method: "POST",
        body: JSON.stringify({
          project: projectPathRef,
          name: params.name,
          type: params.connector_type,
          config: params.config,
          sync_schedule: params.sync_schedule,
        }),
      });
      return created?.source || created;
    });
  }

  async syncSource(sourceId: string): Promise<any> {
    return this.request(`/v1/sources/${sourceId}/sync`, { method: "POST" });
  }

  async updateSource(
    sourceId: string,
    params: {
      project?: string;
      name?: string;
      config?: Record<string, any>;
      configPatch?: Record<string, any>;
      sync?: boolean;
    }
  ): Promise<any> {
    return this.request(`/v1/sources/${encodeURIComponent(sourceId)}`, {
      method: "PATCH",
      body: JSON.stringify(params),
    });
  }

  async deleteSource(sourceId: string, project?: string): Promise<any> {
    const query = project ? `?project=${encodeURIComponent(project)}` : "";
    return this.request(`/v1/sources/${encodeURIComponent(sourceId)}${query}`, { method: "DELETE" });
  }

  async addSourceByType(
    projectId: string,
    params: {
      type: "video";
      url: string;
      auto_sync?: boolean;
      tags?: string[];
      platform?: "youtube" | "loom" | "generic";
      language?: string;
      allow_stt_fallback?: boolean;
      max_duration_minutes?: number;
      name?: string;
      ingestion_profile?: "auto" | "repo" | "web_docs" | "pdf_layout" | "video_transcript" | "plain_text";
      strategy_override?: "fixed" | "recursive" | "semantic" | "hierarchical" | "adaptive";
      profile_config?: Record<string, any>;
    }
  ): Promise<{ source_id: string; sync_job_id?: string | null; status: "processing" | "queued" | "created" }> {
    const result = await this.learn({
      mode: "source",
      project: projectId,
      type: "video",
      name: params.name,
      url: params.url,
      platform: params.platform,
      language: params.language,
      options: {
        async: true,
        auto_index: params.auto_sync ?? true,
        ingestion_profile: params.ingestion_profile,
        strategy_override: params.strategy_override,
        profile_config: params.profile_config,
        allow_stt_fallback: params.allow_stt_fallback,
        max_duration_minutes: params.max_duration_minutes,
      },
    }) as LearnSourceResult;
    return {
      source_id: result.source_id,
      sync_job_id: result.job_id ?? null,
      status:
        result.status === "processing" || result.status === "queued"
          ? result.status
          : "created",
    };
  }

  async getSourceStatus(sourceId: string): Promise<VideoIngestionStatus> {
    return this.request<VideoIngestionStatus>(`/v1/sources/${sourceId}/status`, { method: "GET" });
  }

  async createCanonicalSource(
    project: string,
    params: CanonicalSourceCreateParams
  ): Promise<CanonicalSourceCreateResult> {
    const result = await this.learn({
      mode: "source",
      project,
      type: params.type,
      name: params.name,
      metadata: params.metadata,
      owner: params.owner,
      repo: params.repo,
      branch: params.branch,
      paths: params.paths,
      url: params.url,
      file_path: params.file_path,
      path: params.path,
      channel_ids: params.channel_ids,
      since: params.since,
      token: params.token,
      auth_ref: params.auth_ref,
      platform: params.platform,
      language: params.language,
      options: {
        async: true,
        auto_index: params.auto_index ?? true,
        ingestion_profile: params.ingestion_profile,
        strategy_override: params.strategy_override,
        profile_config: params.profile_config,
        crawl_depth: params.crawl_depth,
        include_paths: params.include_paths,
        exclude_paths: params.exclude_paths,
        glob: params.glob,
        max_files: params.max_files,
        max_pages: params.max_pages,
        extract_mode: params.extract_mode,
        workspace_id: params.workspace_id,
        allow_stt_fallback: params.allow_stt_fallback,
        max_duration_minutes: params.max_duration_minutes,
        max_chunks: params.max_chunks,
      },
    }) as LearnSourceResult;
    return {
      source_id: result.source_id,
      status:
        result.status === "processing"
          ? "indexing"
          : result.status === "created"
            ? "queued"
            : result.status as CanonicalSourceCreateResult["status"],
      job_id: result.job_id ?? null,
      index_started: result.index_started,
      warnings: [],
    };
  }

  async ingest(
    projectId: string,
    documents: Array<{
      id?: string;
      title: string;
      content: string;
      metadata?: Record<string, any>;
      file_path?: string;
      ingestion_profile?: "auto" | "repo" | "web_docs" | "pdf_layout" | "video_transcript" | "plain_text";
      strategy_override?: "fixed" | "recursive" | "semantic" | "hierarchical" | "adaptive";
      profile_config?: Record<string, any>;
    }>
  ): Promise<{ ingested: number }> {
    await Promise.all(
      documents.map((doc) =>
        this.learn({
          mode: "text",
          project: projectId,
          title: doc.title,
          content: doc.content,
          metadata: {
            ...(doc.metadata || {}),
            ...(doc.file_path ? { file_path: doc.file_path } : {}),
          },
          options: {
            async: true,
            ingestion_profile: doc.ingestion_profile,
            strategy_override: doc.strategy_override,
            profile_config: doc.profile_config,
          },
        })
      )
    );
    return { ingested: documents.length };
  }

  async addContext(params: {
      project?: string;
      content: string;
      title?: string;
      metadata?: Record<string, any>;
  }): Promise<{ ingested: number }> {
    await this.learn({
      mode: "text",
      project: this.getRequiredProject(params.project),
      title: params.title || "Context",
      content: params.content,
      metadata: params.metadata || { source: "addContext" },
      options: {
        async: true,
      },
    });
    return { ingested: 1 };
  }

  async learn(params: LearnInput): Promise<LearnResult> {
    const projectRef = this.getRequiredProject(params.project);
    return this.withProjectRefFallback(projectRef, (project) => this.request<LearnResult>("/v1/learn", {
      method: "POST",
      body: JSON.stringify({
        ...params,
        project,
      }),
    }));
  }

  async listMemories(params: {
      project?: string;
      user_id?: string;
      session_id?: string;
      agent_id?: string;
      limit?: number;
    }): Promise<{ memories: any[] }> {
      const projectRef = this.getRequiredProject(params.project);
      return this.withProjectRefFallback(projectRef, async (project) => {
        const query = new URLSearchParams({
          project,
          ...(params.user_id ? { user_id: params.user_id } : {}),
          ...(params.session_id ? { session_id: params.session_id } : {}),
          ...(params.agent_id ? { agent_id: params.agent_id } : {}),
          limit: String(Math.min(Math.max(params.limit ?? 200, 1), 200)),
        });
        return this.request<{ memories: any[] }>(`/v1/memories?${query.toString()}`, { method: "GET" });
      });
    }

  async addMemory(params: {
      project?: string;
      content: string;
      memory_type?:
      | "factual"
      | "episodic"
      | "semantic"
      | "procedural"
      | "preference"
      | "event"
      | "relationship"
      | "opinion"
      | "goal"
      | "instruction"
      | "decision"
      | "constraint"
      | "solution"
      | "project_state"
      | "correction"
      | "workflow";
    user_id?: string;
    session_id?: string;
    agent_id?: string;
    task_id?: string;
    importance?: number;
    confidence?: number;
    scope_target?: MemoryScopeTarget;
    promotion_mode?: PromotionMode;
    metadata?: Record<string, any>;
    expires_in_seconds?: number;
    async?: boolean;
    write_mode?: "async" | "sync";
    allow_legacy_fallback?: boolean;
  }): Promise<MemoryWriteResult> {
    const projectRef = this.getRequiredProject(params.project);
    return this.withProjectRefFallback(projectRef, async (project) => {
      const toSotaType = (
        memoryType: typeof params.memory_type
      ): MemoryKind | undefined => {
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
      };

      const toLegacyType = (
        memoryType: typeof params.memory_type
      ): "factual" | "episodic" | "semantic" | "procedural" | undefined => {
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
            return memoryType as "factual" | "episodic" | "semantic" | "procedural" | undefined;
        }
      };

      // SOTA is default path.
      try {
        const direct = await this.request<any>("/v1/memory", {
          method: "POST",
          body: JSON.stringify({
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
            async: params.async,
            write_mode: params.write_mode || (params.async === true ? "async" : "sync"),
          }),
        });

        const mode = direct?.mode === "async" ? "async" : direct?.mode === "sync" ? "sync" : undefined;
        const memoryId =
          direct?.memory?.id ||
          direct?.memory_id ||
          (mode !== "async" ? direct?.id : undefined);
        const jobId =
          direct?.job_id ||
          (mode === "async" ? direct?.id : undefined);
        const id = memoryId || jobId || "";
        if (id) {
          return {
            id,
            success: true,
            path: "sota",
            fallback_used: false,
            mode,
            ...(memoryId ? { memory_id: memoryId } : {}),
            ...(jobId ? { job_id: jobId } : {}),
            ...(direct?.status_url ? { status_url: direct.status_url } : {}),
            ...(direct?.accepted_at ? { accepted_at: direct.accepted_at } : {}),
            ...(direct?.visibility_sla_ms ? { visibility_sla_ms: direct.visibility_sla_ms } : {}),
            ...(direct?.pending_visibility !== undefined ? { pending_visibility: Boolean(direct.pending_visibility) } : {}),
            ...(direct?.semantic_status ? { semantic_status: direct.semantic_status } : {}),
          };
        }
        if (direct?.success === true) {
          // Some deployments use async ingestion and return job_id/status_url without memory id.
          return {
            id: "",
            success: true,
            path: "sota",
            fallback_used: false,
            mode,
            ...(direct?.status_url ? { status_url: direct.status_url } : {}),
            ...(direct?.accepted_at ? { accepted_at: direct.accepted_at } : {}),
            ...(direct?.visibility_sla_ms ? { visibility_sla_ms: direct.visibility_sla_ms } : {}),
            ...(direct?.pending_visibility !== undefined ? { pending_visibility: Boolean(direct.pending_visibility) } : {}),
            ...(direct?.semantic_status ? { semantic_status: direct.semantic_status } : {}),
          };
        }
      } catch (error) {
        if (params.allow_legacy_fallback === false) {
          throw error;
        }
      }

      // Legacy fallback for compatibility with older deployments.
      const legacy = await this.request<any>("/v1/memories", {
        method: "POST",
        body: JSON.stringify({
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
            ...(params.scope_target ? { scope_target: params.scope_target } : {}),
            ...(params.promotion_mode ? { promotion_mode: params.promotion_mode } : {}),
          },
          expires_in_seconds: params.expires_in_seconds,
        }),
      });

      const id = legacy?.memory?.id || legacy?.id || legacy?.memory_id;
      if (!id) {
        throw new RetainDBError({
          code: "REQUEST_FAILED",
          message: "Memory create succeeded but no memory id was returned by the API",
        });
      }

      return {
        id,
        success: true,
        path: "legacy",
        fallback_used: true,
        mode: "sync",
        memory_id: id,
        semantic_status: "ready",
      };
    });
  }

  async addMemoriesBulk(params: {
    project?: string;
    memories: Array<{
      content: string;
      memory_type?: MemoryKind | "episodic" | "semantic" | "procedural";
      user_id?: string;
      session_id?: string;
      agent_id?: string;
      task_id?: string;
      scope_target?: MemoryScopeTarget;
      importance?: number;
      confidence?: number;
      metadata?: Record<string, any>;
      entity_mentions?: string[];
      document_date?: string;
      event_date?: string;
    }>;
    namespace?: string;
    tags?: string[];
    promotion_mode?: PromotionMode;
    async?: boolean;
    write_mode?: "async" | "sync";
    webhook_url?: string;
  }): Promise<any> {
    const projectRef = this.getRequiredProject(params.project);
    return this.withProjectRefFallback(projectRef, async (project) => {
      try {
        return await this.request("/v1/memory/bulk", {
          method: "POST",
          body: JSON.stringify({ ...params, project }),
        });
      } catch (error) {
        if (!this.isEndpointNotFoundError(error)) {
          throw error;
        }

        // Legacy fallback for deployments that do not expose /v1/memory/bulk
        const created = await Promise.all(
          params.memories.map((memory) =>
            this.addMemory({
              project,
              content: memory.content,
              memory_type: memory.memory_type,
              user_id: memory.user_id,
              session_id: memory.session_id,
              agent_id: memory.agent_id,
              task_id: memory.task_id,
              importance: memory.importance,
              confidence: memory.confidence,
              scope_target: memory.scope_target,
              promotion_mode: params.promotion_mode,
              metadata: memory.metadata,
              allow_legacy_fallback: true,
            })
          )
        );

        return {
          success: true,
          created: created.length,
          memories: created,
          path: "legacy",
          fallback_used: true,
        };
      }
    });
  }

  async extractMemories(params: {
    project?: string;
    message: string;
    context?: string;
    session_id?: string;
    user_id?: string;
    enable_pattern?: boolean;
    enable_inference?: boolean;
    min_confidence?: number;
  }): Promise<MemoryExtractionResult> {
    const projectRef = this.getRequiredProject(params.project);
    return this.withProjectRefFallback(projectRef, (project) => this.request<MemoryExtractionResult>("/v1/memory/extract", {
      method: "POST",
      body: JSON.stringify({ ...params, project }),
    }));
  }

  async extractSessionMemories(params: {
    project?: string;
    user_id?: string;
    messages: Array<{
      role: "user" | "assistant" | "system";
      content: string;
      timestamp?: string;
    }>;
    enable_pattern?: boolean;
    enable_inference?: boolean;
  }): Promise<{ memories: ExtractedMemory[]; count: number; latencyMs: number }> {
    const projectRef = this.getRequiredProject(params.project);
    return this.withProjectRefFallback(projectRef, (project) => this.request("/v1/memory/extract/session", {
      method: "POST",
      body: JSON.stringify({
        ...params,
        project,
        messages: params.messages.map((m) => ({
          ...m,
          timestamp: m.timestamp || new Date().toISOString(),
        })),
      }),
    }));
  }

  async searchMemories(params: {
    project?: string;
    query: string;
    user_id?: string;
    session_id?: string;
    agent_id?: string;
    task_id?: string;
    question_date?: string;
    memory_type?: MemoryKind;
    scope_targets?: MemoryScopeTarget[];
    top_k?: number;
    profile?: "fast" | "balanced" | "quality";
    include_pending?: boolean;
    source_ids?: string[];
    tags?: string[];
    namespace?: string;
    include_memories?: boolean;
    include_relations?: boolean;
  }): Promise<MemorySearchResponse> {
    const projectRef = this.getRequiredProject(params.project);
    return this.withProjectRefFallback(projectRef, async (project) => {
      try {
        return await this.request("/v1/memory/search", {
          method: "POST",
          body: JSON.stringify({
            query: params.query,
            project,
            user_id: params.user_id,
            session_id: params.session_id,
            agent_id: params.agent_id,
            task_id: params.task_id,
            question_date: params.question_date,
            scope_targets: params.scope_targets,
            memory_types: params.memory_type ? [params.memory_type] : undefined,
            top_k: params.top_k || 10,
            profile: params.profile,
            include_pending: params.include_pending,
            source_ids: params.source_ids,
            tags: params.tags,
            namespace: params.namespace,
            include_memories: params.include_memories,
            include_relations: params.include_relations,
          }),
        });
      } catch (error) {
        if (!this.isEndpointNotFoundError(error)) {
          throw error;
        }

        const legacyTypeMap: Record<string, "factual" | "episodic" | "semantic" | "procedural"> = {
          factual: "factual",
          preference: "semantic",
          event: "episodic",
          relationship: "semantic",
          opinion: "semantic",
          goal: "semantic",
          instruction: "procedural",
        };

        return this.request("/v1/memories/search", {
          method: "POST",
          body: JSON.stringify({
            query: params.query,
            project,
            user_id: params.user_id,
            session_id: params.session_id,
            agent_id: params.agent_id,
            task_id: params.task_id,
            memory_type: params.memory_type ? legacyTypeMap[params.memory_type] : undefined,
            top_k: params.top_k || 10,
          }),
        });
      }
    });
  }

  async createApiKey(params: {
    name: string;
    scopes?: string[];
    rate_limit?: number;
    expires_in_days?: number;
  }): Promise<{ key: string; prefix: string; name: string }> {
    return this.request("/v1/keys", {
      method: "POST",
      body: JSON.stringify(params),
    });
  }

  async listApiKeys(): Promise<{ keys: any[] }> {
    return this.request<{ keys: any[] }>("/v1/keys");
  }

  async getUsage(days = 30): Promise<any> {
    return this.request(`/v1/usage?days=${days}`);
  }

  async searchMemoriesSOTA(params: {
    query: string;
    project?: string;
    user_id?: string;
    session_id?: string;
    agent_id?: string;
    task_id?: string;
    question_date?: string;
    top_k?: number;
    memory_types?: MemoryKind[];
    scope_targets?: MemoryScopeTarget[];
    source_ids?: string[];
    include_inactive?: boolean;
    include_chunks?: boolean;
    include_memories?: boolean;
    include_relations?: boolean;
    tags?: string[];
    namespace?: string;
    fast_mode?: boolean;
    profile?: "fast" | "balanced" | "quality";
    include_pending?: boolean;
  }): Promise<MemorySearchResponse> {
    const projectRef = this.getRequiredProject(params.project);
    return this.withProjectRefFallback(projectRef, async (project) => {
      try {
        return await this.request("/v1/memory/search", {
          method: "POST",
          body: JSON.stringify({ ...params, project }),
        });
      } catch (error) {
        if (!this.isEndpointNotFoundError(error)) {
          throw error;
        }

        const firstType = params.memory_types?.[0];
        return this.searchMemories({
          project,
          query: params.query,
          user_id: params.user_id,
          session_id: params.session_id,
          agent_id: params.agent_id,
          task_id: params.task_id,
          memory_type: firstType,
          scope_targets: params.scope_targets,
          question_date: params.question_date,
          top_k: params.top_k,
          profile: params.profile,
          include_pending: params.include_pending,
          source_ids: params.source_ids,
          tags: params.tags,
          namespace: params.namespace,
          include_memories: params.include_memories,
          include_relations: params.include_relations,
        });
      }
    });
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
    const projectRef = this.getRequiredProject(params.project);
    return this.withProjectRefFallback(projectRef, (project) => this.request("/v1/memory/ingest/session", {
      method: "POST",
      body: JSON.stringify({ ...params, project }),
    }));
  }

  async getSessionMemories(params: {
    session_id: string;
    project?: string;
    limit?: number;
    since_date?: string;
    include_pending?: boolean;
  }): Promise<{ memories: any[]; count: number }> {
    const projectRef = this.getRequiredProject(params.project);
    return this.withProjectRefFallback(projectRef, async (project) => {
      const query = new URLSearchParams({
        project,
        ...(params.limit && { limit: params.limit.toString() }),
        ...(params.since_date && { since_date: params.since_date }),
        ...(params.include_pending !== undefined && { include_pending: String(params.include_pending) }),
      });

      try {
        return await this.request(`/v1/memory/session/${params.session_id}?${query}`);
      } catch (error) {
        if (!this.isEndpointNotFoundError(error)) {
          throw error;
        }
        return { memories: [], count: 0 };
      }
    });
  }

  async getUserProfile(params: {
    user_id: string;
    project?: string;
    memory_types?: string;
    include_pending?: boolean;
  }): Promise<{ user_id: string; memories: any[]; count: number }> {
    const projectRef = this.getRequiredProject(params.project);
    return this.withProjectRefFallback(projectRef, async (project) => {
      const query = new URLSearchParams({
        project,
        ...(params.memory_types && { memory_types: params.memory_types }),
        ...(params.include_pending !== undefined && { include_pending: String(params.include_pending) }),
      });

      try {
        return await this.request(`/v1/memory/profile/${params.user_id}?${query}`);
      } catch (error) {
        if (!this.isEndpointNotFoundError(error)) {
          throw error;
        }

        const legacyQuery = new URLSearchParams({
          project,
          user_id: params.user_id,
          limit: "200",
        });
        const legacy = await this.request<{ memories?: any[] }>(`/v1/memories?${legacyQuery}`);
        const memories = Array.isArray(legacy?.memories) ? legacy.memories : [];
        return {
          user_id: params.user_id,
          memories,
          count: memories.length,
        };
      }
    });
  }

  async getMemory(memoryId: string): Promise<{ memory: any }> {
    try {
      return await this.request(`/v1/memory/${memoryId}`);
    } catch (error) {
      if (!this.isEndpointNotFoundError(error)) {
        throw error;
      }
      return this.request(`/v1/memories/${memoryId}`);
    }
  }

  async getMemoryVersions(memoryId: string): Promise<{ memory_id: string; versions: any[]; count: number }> {
    return this.request(`/v1/memory/${memoryId}/versions`);
  }

  async updateMemory(
    memoryId: string,
    params: { content: string; reasoning?: string }
  ): Promise<{ success: boolean; new_memory_id: string; old_memory_id: string }> {
    try {
      return await this.request(`/v1/memory/${memoryId}`, {
        method: "PUT",
        body: JSON.stringify(params),
      });
    } catch (error) {
      if (!this.isEndpointNotFoundError(error)) {
        throw error;
      }
      const legacy = await this.request<any>(`/v1/memories/${memoryId}`, {
        method: "PUT",
        body: JSON.stringify({
          content: params.content,
        }),
      });
      return {
        success: true,
        new_memory_id: legacy?.id || memoryId,
        old_memory_id: memoryId,
      };
    }
  }

  async deleteMemory(memoryId: string): Promise<{ success: boolean; deleted: string }> {
    try {
      return await this.request(`/v1/memory/${memoryId}`, { method: "DELETE" });
    } catch (error) {
      if (!this.isEndpointNotFoundError(error)) {
        throw error;
      }
      await this.request(`/v1/memories/${memoryId}`, { method: "DELETE" });
      return {
        success: true,
        deleted: memoryId,
      };
    }
  }

  async getMemoryRelations(memoryId: string): Promise<{ memory_id: string; relations: any[]; count: number }> {
    return this.request(`/v1/memory/${memoryId}/relations`);
  }

  async getMemoryGraph(params: {
    project?: string;
    user_id?: string;
    session_id?: string;
    session_ids?: string[];
    view?: "default" | "temporal" | "entity" | "session";
    entity?: string;
    include_inactive?: boolean;
    limit?: number;
  }): Promise<any> {
    const projectRef = this.getRequiredProject(params.project);
    return this.withProjectRefFallback(projectRef, (project) => {
      const query = new URLSearchParams({
        project,
        ...(params.user_id && { user_id: params.user_id }),
        ...(params.session_id && { session_id: params.session_id }),
        ...(params.session_ids?.length ? { session_ids: params.session_ids.join(",") } : {}),
        ...(params.view && { view: params.view }),
        ...(params.entity && { entity: params.entity }),
        ...(params.include_inactive !== undefined && { include_inactive: String(params.include_inactive) }),
        ...(params.limit !== undefined && { limit: String(params.limit) }),
      });
      return this.request(`/v1/memory/graph?${query}`);
    });
  }

  async getConversationGraph(params: {
    project?: string;
    session_id: string;
    include_inactive?: boolean;
    limit?: number;
  }): Promise<any> {
    const projectRef = this.getRequiredProject(params.project);
    return this.withProjectRefFallback(projectRef, (project) => {
      const query = new URLSearchParams({
        project,
        ...(params.include_inactive !== undefined && { include_inactive: String(params.include_inactive) }),
        ...(params.limit !== undefined && { limit: String(params.limit) }),
      });
      return this.request(`/v1/memory/graph/conversation/${params.session_id}?${query}`);
    });
  }

  async getUserModel(params: { project?: string; user_id: string }): Promise<any> {
    const projectRef = this.getRequiredProject(params.project);
    return this.withProjectRefFallback(projectRef, (project) => {
      const query = new URLSearchParams({ project });
      return this.request(`/v1/memory/profile/${params.user_id}/model?${query}`);
    });
  }

  async getUserGaps(params: { project?: string; user_id: string; context: string; limit?: number }): Promise<any> {
    const projectRef = this.getRequiredProject(params.project);
    return this.withProjectRefFallback(projectRef, (project) =>
      this.request(`/v1/memory/profile/${params.user_id}/gaps`, {
        method: "POST",
        body: JSON.stringify({
          project,
          context: params.context,
          ...(params.limit !== undefined ? { limit: params.limit } : {}),
        }),
      })
    );
  }

  async oracleSearch(params: {
    query: string;
    project?: string;
    max_results?: number;
    mode?: "search" | "research";
    max_steps?: number;
  }): Promise<any> {
    const projectRef = this.getRequiredProject(params.project);
    return this.withProjectRefFallback(projectRef, (project) =>
      this.request("/v1/oracle/search", {
        method: "POST",
        body: JSON.stringify({ ...params, project }),
      })
    );
  }

  async autosubscribe(params: {
    project?: string;
    source: {
      type: "github" | "local";
      owner?: string;
      repo?: string;
      path?: string;
    };
    dependency_file?: "package.json" | "requirements.txt" | "Cargo.toml" | "go.mod" | "Gemfile";
    index_limit?: number;
    auto_sync?: boolean;
  }): Promise<{
    success: boolean;
    discovered: number;
    indexed: number;
    errors: string[];
    dependencies?: any[];
    auto_sync_enabled: boolean;
  }> {
    const projectRef = this.getRequiredProject(params.project);
    return this.withProjectRefFallback(projectRef, (project) =>
      this.request("/v1/autosubscribe", {
        method: "POST",
        body: JSON.stringify({ ...params, project }),
      })
    );
  }

  async createSharedContext(params: {
    session_id: string;
    project?: string;
    title?: string;
    include_memories?: boolean;
    include_chunks?: boolean;
    expiry_days?: number;
  }): Promise<{
    success: boolean;
    share_id: string;
    share_url: string;
    title: string;
    memories_count: number;
    messages_count: number;
    expires_at: string;
  }> {
    const projectRef = this.getRequiredProject(params.project);
    return this.withProjectRefFallback(projectRef, (project) =>
      this.request("/v1/context/share", {
        method: "POST",
        body: JSON.stringify({ ...params, project }),
      })
    );
  }

  async loadSharedContext(shareId: string): Promise<{
    share_id: string;
    title: string;
    created_at: string;
    expires_at: string;
    memories: any[];
    messages: any[];
    chunks?: any[];
    metadata: any;
  }> {
    return this.request(`/v1/context/shared/${shareId}`);
  }

  async resumeFromSharedContext(params: {
    share_id: string;
    project?: string;
    new_session_id?: string;
  }): Promise<{
    success: boolean;
    session_id: string;
    memories_restored: number;
    messages_restored: number;
    chunks_restored: number;
  }> {
    const projectRef = this.getRequiredProject(params.project);
    return this.withProjectRefFallback(projectRef, (project) =>
      this.request("/v1/context/resume", {
        method: "POST",
        body: JSON.stringify({ ...params, project }),
      })
    );
  }

  async consolidateMemories(params: {
    project?: string;
    similarity_threshold?: number;
    auto_merge?: boolean;
    dry_run?: boolean;
  }): Promise<any> {
    const projectRef = this.getRequiredProject(params.project);
    return this.withProjectRefFallback(projectRef, (project) =>
      this.request("/v1/memory/consolidate", {
        method: "POST",
        body: JSON.stringify({ ...params, project }),
      })
    );
  }

  async updateImportanceDecay(params: {
    project?: string;
    decay_function?: "exponential" | "linear" | "logarithmic";
    half_life_days?: number;
    access_boost?: number;
    auto_archive?: boolean;
    archive_threshold?: number;
  }): Promise<{
    success: boolean;
    memories_updated: number;
    average_importance: number;
    memories_archived: number;
    config: any;
  }> {
    const projectRef = this.getRequiredProject(params.project);
    return this.withProjectRefFallback(projectRef, (project) =>
      this.request("/v1/memory/decay/update", {
        method: "POST",
        body: JSON.stringify({ ...params, project }),
      })
    );
  }

  async getImportanceStats(project?: string): Promise<{ project_id: string; statistics: any }> {
    const projectRef = this.getRequiredProject(project);
    return this.withProjectRefFallback(projectRef, (resolvedProject) =>
      this.request(`/v1/memory/decay/stats?project=${encodeURIComponent(resolvedProject)}`)
    );
  }

  async getCacheStats(): Promise<{
    cache_type: string;
    hit_rate: number;
    total_requests: number;
    hits: number;
    misses: number;
    size_bytes: number;
    keys_count: number;
    average_latency_ms: number;
    uptime_seconds: number;
  }> {
    return this.request("/v1/cache/stats");
  }

  async warmCache(params: {
    project?: string;
    queries: string[];
    ttl_seconds?: number;
  }): Promise<{
    success: boolean;
    queries_warmed: number;
    errors: string[];
    cache_size_increase_bytes: number;
  }> {
    const projectRef = this.getRequiredProject(params.project);
    return this.withProjectRefFallback(projectRef, (project) =>
      this.request("/v1/cache/warm", {
        method: "POST",
        body: JSON.stringify({ ...params, project }),
      })
    );
  }

  async clearCache(params: {
    pattern?: string;
    clear_all?: boolean;
  }): Promise<{ success: boolean; keys_cleared: number; bytes_freed: number }> {
    return this.request("/v1/cache/clear", {
      method: "DELETE",
      body: JSON.stringify(params),
    });
  }

  async getCostSummary(params: {
    project?: string;
    start_date?: string;
    end_date?: string;
  } = {}): Promise<any> {
    const resolvedProject = params.project ? await this.resolveProjectId(params.project) : undefined;
    const query = new URLSearchParams({
      ...(resolvedProject && { project: resolvedProject }),
      ...(params.start_date && { start_date: params.start_date }),
      ...(params.end_date && { end_date: params.end_date }),
    });
    return this.request(`/v1/cost/summary?${query}`);
  }

  async getCostBreakdown(params: {
    project?: string;
    group_by?: "model" | "task" | "day" | "hour";
    start_date?: string;
    end_date?: string;
  } = {}): Promise<any> {
    const resolvedProject = params.project ? await this.resolveProjectId(params.project) : undefined;
    const query = new URLSearchParams({
      ...(resolvedProject && { project: resolvedProject }),
      ...(params.group_by && { group_by: params.group_by }),
      ...(params.start_date && { start_date: params.start_date }),
      ...(params.end_date && { end_date: params.end_date }),
    });
    return this.request(`/v1/cost/breakdown?${query}`);
  }

  /**
   * Semantic search over raw documents without pre-indexing.
   * Send file contents/summaries directly — the API embeds them in-memory and ranks by similarity.
   * Perfect for AI agents to semantically explore a codebase on-the-fly.
   */
  async semanticSearch(params: {
    query: string;
    documents: Array<{ id: string; content: string }>;
    top_k?: number;
    threshold?: number;
  }): Promise<{
    results: Array<{
      id: string;
      score: number;
      content: string;
      snippet: string;
    }>;
    total_searched: number;
    total_returned: number;
    query: string;
    latency_ms: number;
  }> {
    return this.request("/v1/search/semantic", {
      method: "POST",
      body: JSON.stringify(params),
    });
  }

  async searchFiles(params: {
    query: string;
    path?: string;
    mode?: "content" | "filename" | "both";
    file_types?: string[];
    max_results?: number;
    context_lines?: number;
    case_sensitive?: boolean;
  }): Promise<{
    results: Array<{
      file: string;
      matches: Array<{
        line: number;
        content: string;
        context_before: string[];
        context_after: string[];
      }>;
    }>;
    total_files: number;
    total_matches: number;
    search_path: string;
    mode: string;
    latency_ms: number;
    engine: "ripgrep" | "node";
  }> {
    return this.request("/v1/search/files", {
      method: "POST",
      body: JSON.stringify(params),
    });
  }

  async getCostSavings(params: {
    project?: string;
    start_date?: string;
    end_date?: string;
  } = {}): Promise<any> {
    const resolvedProject = params.project ? await this.resolveProjectId(params.project) : undefined;
    const query = new URLSearchParams({
      ...(resolvedProject && { project: resolvedProject }),
      ...(params.start_date && { start_date: params.start_date }),
      ...(params.end_date && { end_date: params.end_date }),
    });
    return this.request(`/v1/cost/savings?${query}`);
  }

  // Backward-compatible grouped namespaces.
  readonly projects = {
    create: (params: { name: string; description?: string; settings?: Record<string, any> }) => this.createProject(params),
    list: () => this.listProjects(),
    get: (id: string) => this.getProject(id),
    delete: (id: string) => this.deleteProject(id),
  };

  readonly sources = {
    list: (project?: string) => this.listSources(project),
    create: (
      projectId: string,
      params: { name: string; connector_type: string; config: Record<string, any>; sync_schedule?: string }
    ) => this.addSource(projectId, params),
    add: (
      projectId: string,
      params: { name: string; connector_type: string; config: Record<string, any>; sync_schedule?: string }
    ) => this.addSource(projectId, params),
    addSource: (
      projectId: string,
      params: {
        type: "video";
        url: string;
        auto_sync?: boolean;
        tags?: string[];
        platform?: "youtube" | "loom" | "generic";
        language?: string;
        allow_stt_fallback?: boolean;
        max_duration_minutes?: number;
        name?: string;
      }
    ) => this.addSourceByType(projectId, params),
    sync: (sourceId: string) => this.syncSource(sourceId),
    syncSource: (sourceId: string) => this.syncSource(sourceId),
    update: (sourceId: string, params: Parameters<RetainDBContext["updateSource"]>[1]) => this.updateSource(sourceId, params),
    updateSource: (sourceId: string, params: Parameters<RetainDBContext["updateSource"]>[1]) => this.updateSource(sourceId, params),
    delete: (sourceId: string, project?: string) => this.deleteSource(sourceId, project),
    deleteSource: (sourceId: string, project?: string) => this.deleteSource(sourceId, project),
    status: (sourceId: string) => this.getSourceStatus(sourceId),
    getStatus: (sourceId: string) => this.getSourceStatus(sourceId),
  };

  readonly memory = {
    add: (params: Parameters<RetainDBContext["addMemory"]>[0]) => this.addMemory(params),
    addBulk: (params: Parameters<RetainDBContext["addMemoriesBulk"]>[0]) => this.addMemoriesBulk(params),
    extract: (params: Parameters<RetainDBContext["extractMemories"]>[0]) => this.extractMemories(params),
    extractSession: (params: Parameters<RetainDBContext["extractSessionMemories"]>[0]) => this.extractSessionMemories(params),
    search: (params: Parameters<RetainDBContext["searchMemories"]>[0]) => this.searchMemories(params),
    searchSOTA: (params: Parameters<RetainDBContext["searchMemoriesSOTA"]>[0]) => this.searchMemoriesSOTA(params),
    ingestSession: (params: Parameters<RetainDBContext["ingestSession"]>[0]) => this.ingestSession(params),
    getSessionMemories: (params: Parameters<RetainDBContext["getSessionMemories"]>[0]) => this.getSessionMemories(params),
    getUserProfile: (params: Parameters<RetainDBContext["getUserProfile"]>[0]) => this.getUserProfile(params),
    get: (memoryId: string) => this.getMemory(memoryId),
    getVersions: (memoryId: string) => this.getMemoryVersions(memoryId),
    update: (memoryId: string, params: Parameters<RetainDBContext["updateMemory"]>[1]) => this.updateMemory(memoryId, params),
    delete: (memoryId: string) => this.deleteMemory(memoryId),
    getRelations: (memoryId: string) => this.getMemoryRelations(memoryId),
    getGraph: (params: Parameters<RetainDBContext["getMemoryGraph"]>[0]) => this.getMemoryGraph(params),
    getConversationGraph: (params: Parameters<RetainDBContext["getConversationGraph"]>[0]) => this.getConversationGraph(params),
    getModel: (params: Parameters<RetainDBContext["getUserModel"]>[0]) => this.getUserModel(params),
    getGaps: (params: Parameters<RetainDBContext["getUserGaps"]>[0]) => this.getUserGaps(params),
    consolidate: (params: Parameters<RetainDBContext["consolidateMemories"]>[0]) => this.consolidateMemories(params),
    updateDecay: (params: Parameters<RetainDBContext["updateImportanceDecay"]>[0]) => this.updateImportanceDecay(params),
    getImportanceStats: (project?: string) => this.getImportanceStats(project),
  };

  readonly keys = {
    create: (params: Parameters<RetainDBContext["createApiKey"]>[0]) => this.createApiKey(params),
    list: () => this.listApiKeys(),
    getUsage: (days?: number) => this.getUsage(days),
  };

  readonly oracle = {
    search: (params: Parameters<RetainDBContext["oracleSearch"]>[0]) => this.oracleSearch(params),
  };

  readonly context = {
    query: (params: QueryParams) => this.query(params),
    files: (params?: ContextFilesystemParams) => this.readContextFile(params || {}),
    readFile: (path: string, params?: Omit<ContextFilesystemParams, "path">) => this.readContextFile({ ...(params || {}), path, includeContents: true }),
    createShare: (params: Parameters<RetainDBContext["createSharedContext"]>[0]) => this.createSharedContext(params),
    loadShare: (shareId: string) => this.loadSharedContext(shareId),
    resumeShare: (params: Parameters<RetainDBContext["resumeFromSharedContext"]>[0]) => this.resumeFromSharedContext(params),
  };

  readonly optimization = {
    getCacheStats: () => this.getCacheStats(),
    warmCache: (params: Parameters<RetainDBContext["warmCache"]>[0]) => this.warmCache(params),
    clearCache: (params: Parameters<RetainDBContext["clearCache"]>[0]) => this.clearCache(params),
    getCostSummary: (params?: Parameters<RetainDBContext["getCostSummary"]>[0]) => this.getCostSummary(params),
    getCostBreakdown: (params?: Parameters<RetainDBContext["getCostBreakdown"]>[0]) => this.getCostBreakdown(params),
    getCostSavings: (params?: Parameters<RetainDBContext["getCostSavings"]>[0]) => this.getCostSavings(params),
  };
}

export { RetainDBClient } from "./context.js";
export { RetainDBError };
export type { RetainDBErrorCode };
export type {
  RunContext,
  RetainDBClientConfig,
  RetainDBEnvironment,
  RetainDBIdentityMode,
  RetainDBPreflightCheck,
  RetainDBPreflightResult,
  RetainDBResolvedIdentity,
  RetainDBAgentScope,
  RetainDBTaskScope,
  AgentMemoryEventInput,
  AgentMemoryContextInput,
  AgentMemoryHandoffInput,
  RememberParams,
  IngestParams,
  QueryInput,
} from "./context.js";
export type {
  AgentRunContext,
  RetainDBAgentRuntime,
  AgentRuntimeRankWeights,
  AgentRuntimeRetrievalOptions,
  AgentRuntimeSourceActivityOptions,
  AgentRuntimeOptions,
  AgentRuntimeStatus,
  PreparedTurn,
  TurnCaptureResult,
  TurnInput,
  WorkEvent,
  WorkEventKind,
  WorkEventSalience,
} from "./agent-runtime.js";
export type {
  LearnConversationInput,
  LearnConversationResult,
  LearnInput,
  LearnResult,
  LearnSourceInput,
  LearnSourceResult,
  LearnSourceType,
  LearnTextInput,
  LearnTextResult,
} from "./modules/types.js";
export { createAgentMiddleware } from "./middleware.js";
export { createLangChainMemoryAdapter, LangChainMemoryAdapter } from "./adapters/langchain.js";
export { createLangGraphCheckpointAdapter, LangGraphCheckpointAdapter } from "./adapters/langgraph.js";
export { withRetainDB } from "./adapters/ai-sdk.js";
export { retaindbTools } from "./adapters/tools.js";
export type { RetainDBToolDefinition, RetainDBToolsOptions } from "./adapters/tools.js";
export {
  RetainDBMemoryRouter,
  createMemoryRouter,
  type MemoryRouterConfig,
  type MemoryRouterResult,
  type MemoryRouterTrace,
  type MemoryRouterFallbackReason,
} from "./router/memory-router.js";
export { memoryGraphToMermaid } from "./graph-utils.js";
export default RetainDBContext;

// Primary SDK — use RetainDB for new projects
export { RetainDB } from "./retaindb.js";
export type { RetainDBOptions, Message, TurnContext, UserScope, SessionScope, MemoryItem } from "./retaindb.js";
