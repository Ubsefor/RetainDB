import { nowIso, randomId, stableHash } from "./core/utils.js";
import type { MemoryKind, MemorySearchResponse, MemoryWriteAck } from "./modules/types.js";
import type { Project, QueryParams, QueryResult } from "./index.js";

export interface AgentRunContext {
  workspacePath?: string;
  project?: string;
  userId?: string;
  sessionId?: string;
  agentId?: string;
  taskId?: string;
  traceId?: string;
  clientName?: string;
}

export interface TurnInput {
  userMessage: string;
  taskSummary?: string;
  touchedFiles?: string[];
  toolContext?: string;
}

export type WorkEventKind =
  | "decision"
  | "constraint"
  | "outcome"
  | "failure"
  | "task_update"
  | "file_edit"
  | "tool_result";

export type WorkEventSalience = "low" | "medium" | "high";

export interface WorkEvent {
  kind: WorkEventKind;
  summary: string;
  details?: string;
  salience?: WorkEventSalience;
  timestamp?: string;
  filePaths?: string[];
  toolName?: string;
  success?: boolean;
}

export interface PreparedTurn {
  scope: AgentRunContext & { project: string; userId: string; sessionId: string };
  retrieval: {
    primaryQuery: string;
    taskFrameQuery: string | null;
    warnings: string[];
    degraded: boolean;
    degradedReason?: string;
    durationMs: number;
    targetBudgetMs: number;
    hardTimeoutMs: number;
    branchStatus: Record<string, "ok" | "error" | "timeout" | "skipped">;
    focusedScopeApplied: boolean;
    focusedSourceIds: string[];
    focusedFileHints: string[];
    clientScoped: boolean;
    fallbackUsed: boolean;
    droppedBelowFloor: number;
    dedupedCount: number;
  };
  context: string;
  items: Array<{
    id: string;
    content: string;
    type: "project" | "memory";
    score: number;
    sourceQuery: "primary" | "task_frame" | "bootstrap";
    metadata?: Record<string, unknown>;
  }>;
}

export interface TurnCaptureResult {
  success: boolean;
  sessionIngested: boolean;
  memoriesCreated: number;
  relationsCreated: number;
  invalidatedCount: number;
  mergedCount: number;
  droppedCount: number;
  warnings: string[];
}

export interface AgentRuntimeStatus {
  clientName: string;
  scope: {
    project?: string;
    userId?: string;
    sessionId?: string;
    agentId?: string;
    taskId?: string;
    source?: "explicit" | "workspace" | "config" | "generated";
    warning?: string;
  };
  queue: {
    queued: number;
    flushing: boolean;
    lastFlushAt?: string;
    lastFlushCount: number;
  };
  retrieval: PreparedTurn["retrieval"] | null;
  counters: {
    mergedCount: number;
    droppedCount: number;
    bufferedLowSalience: number;
    focusedPassHits: number;
    fallbackTriggers: number;
    floorDroppedCount: number;
    injectedItemCount: number;
    sourceScopedTurns: number;
    broadScopedTurns: number;
    totalTurns: number;
  };
}

export interface AgentRuntimeRankWeights {
  focusedPassBonus?: number;
  sourceMatchBonus?: number;
  touchedFileBonus?: number;
  clientMatchBonus?: number;
  highSalienceBonus?: number;
  mediumSalienceBonus?: number;
  staleBroadPenalty?: number;
  unrelatedClientPenalty?: number;
  lowSaliencePenalty?: number;
}

export interface AgentRuntimeSourceActivityOptions {
  maxTurns?: number;
  maxIdleMs?: number;
  decayAfterTurns?: number;
  decayAfterIdleMs?: number;
  evictOnTaskSwitch?: boolean;
}

export interface AgentRuntimeRetrievalOptions {
  focusedTopK?: number;
  broadTopK?: number;
  minFocusedResults?: number;
  minFocusedTopScore?: number;
  minProjectScore?: number;
  minMemoryScore?: number;
  rankWeights?: AgentRuntimeRankWeights;
  sourceActivity?: AgentRuntimeSourceActivityOptions;
}

export interface AgentRuntimeOptions extends AgentRunContext {
  topK?: number;
  maxTokens?: number;
  targetRetrievalMs?: number;
  hardRetrievalTimeoutMs?: number;
  bindingStorePath?: string;
  recentWorkLimit?: number;
  retrieval?: AgentRuntimeRetrievalOptions;
}

interface QueueStatus {
  queued: number;
  flushing: boolean;
  lastFlushAt?: string;
  lastFlushCount: number;
}

interface RuntimeAdapter {
  resolveProject(project?: string): Promise<Project>;
  query(params: QueryParams): Promise<QueryResult>;
  ingestSession(params: {
    project?: string;
    session_id: string;
    user_id?: string;
    agent_id?: string;
    task_id?: string;
    messages: Array<{ role: string; content: string; timestamp: string }>;
    events?: WorkEvent[];
    promotion_mode?: "session_state_v1" | "user_specific_legacy";
    async?: boolean;
    write_mode?: "async" | "sync";
  }): Promise<{
    success: boolean;
    memories_created: number;
    relations_created: number;
    memories_invalidated: number;
    errors?: string[];
  } & MemoryWriteAck>;
  getSessionMemories(params: {
    project?: string;
    session_id: string;
    include_pending?: boolean;
    limit?: number;
  }): Promise<{ memories: Array<Record<string, unknown>>; count: number }>;
  getUserProfile(params: {
    project?: string;
    user_id: string;
    include_pending?: boolean;
    memory_types?: string;
  }): Promise<{ user_id: string; memories: Array<Record<string, unknown>>; count: number }>;
  searchMemories(params: {
    project?: string;
    query: string;
    user_id?: string;
    session_id?: string;
    agent_id?: string;
    task_id?: string;
    top_k?: number;
    memory_type?: MemoryKind;
    profile?: "fast" | "balanced" | "quality";
    include_pending?: boolean;
  }): Promise<MemorySearchResponse>;
  addMemory(params: {
    project?: string;
    content: string;
    memory_type?: MemoryKind;
    user_id?: string;
    session_id?: string;
    agent_id?: string;
    task_id?: string;
    scope_target?: "USER" | "SESSION" | "PROJECT" | "AGENT" | "TASK" | "DOCUMENT";
    promotion_mode?: "session_state_v1" | "user_specific_legacy";
    importance?: number;
    confidence?: number;
    metadata?: Record<string, unknown>;
    event_date?: string;
    write_mode?: "async" | "sync";
    async?: boolean;
  }): Promise<MemoryWriteAck>;
  queueStatus(): QueueStatus;
  flushQueue(): Promise<void>;
}

interface BindingStore {
  load(): Promise<Record<string, string>>;
  save(bindings: Record<string, string>): Promise<void>;
}

interface BranchResult<T> {
  name: string;
  status: "ok" | "error" | "timeout" | "skipped";
  durationMs: number;
  value?: T;
  reason?: string;
}

interface RankedItem {
  id: string;
  content: string;
  type: "project" | "memory";
  score: number;
  sourceQuery: "primary" | "task_frame" | "bootstrap";
  pass: "focused" | "broad" | "bootstrap";
  metadata?: Record<string, unknown>;
}

function detectBrowserStorage():
  | { getItem(name: string): string | null; setItem(name: string, value: string): void }
  | null {
  const maybeStorage = (globalThis as Record<string, unknown>).localStorage;
  if (!maybeStorage || typeof maybeStorage !== "object") return null;
  const candidate = maybeStorage as { getItem?: unknown; setItem?: unknown };
  if (typeof candidate.getItem !== "function" || typeof candidate.setItem !== "function") {
    return null;
  }
  return {
    getItem: candidate.getItem as (name: string) => string | null,
    setItem: candidate.setItem as (name: string, value: string) => void,
  };
}

function createBindingStore(filePath?: string): BindingStore {
  const storage = detectBrowserStorage();
  if (storage) {
    const key = "whisper_agent_runtime_bindings";
    return {
      async load() {
        const raw = storage.getItem(key);
        if (!raw) return {};
        try {
          const parsed = JSON.parse(raw);
          return parsed && typeof parsed === "object" ? parsed as Record<string, string> : {};
        } catch {
          return {};
        }
      },
      async save(bindings) {
        storage.setItem(key, JSON.stringify(bindings));
      },
    };
  }

  return {
    async load() {
      if (typeof process === "undefined") return {};
      const fs = await import("node:fs/promises");
      const path = filePath || `${process.env.USERPROFILE || process.env.HOME || "."}/.whisper/sdk/agent-bindings.json`;
      try {
        const raw = await fs.readFile(path, "utf8");
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === "object" ? parsed as Record<string, string> : {};
      } catch {
        return {};
      }
    },
    async save(bindings) {
      if (typeof process === "undefined") return;
      const fs = await import("node:fs/promises");
      const pathMod = await import("node:path");
      const path = filePath || `${process.env.USERPROFILE || process.env.HOME || "."}/.whisper/sdk/agent-bindings.json`;
      await fs.mkdir(pathMod.dirname(path), { recursive: true });
      await fs.writeFile(path, JSON.stringify(bindings), "utf8");
    },
  };
}

function normalizeWorkspacePath(value?: string): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function pathBase(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts[parts.length - 1] || normalized;
}

function defaultSalience(kind: WorkEventKind, success?: boolean): WorkEventSalience {
  if (kind === "decision" || kind === "constraint" || kind === "failure") return "high";
  if (kind === "outcome" || kind === "task_update") return "medium";
  if (kind === "tool_result" && success === false) return "high";
  return "low";
}

function toMemoryType(kind: WorkEventKind): MemoryKind {
  if (kind === "decision") return "decision";
  if (kind === "constraint" || kind === "failure") return "constraint";
  if (kind === "outcome" || kind === "tool_result") return "solution";
  if (kind === "task_update") return "project_state";
  if (kind === "file_edit") return "workflow";
  return "event";
}

function summarizeLowSalience(events: WorkEvent[]): string {
  const lines = events.slice(-10).map((event) => {
    const fileSuffix = event.filePaths?.length ? ` [files: ${event.filePaths.join(", ")}]` : "";
    const toolSuffix = event.toolName ? ` [tool: ${event.toolName}]` : "";
    return `- ${event.kind}: ${event.summary}${fileSuffix}${toolSuffix}`;
  });
  return `Recent low-salience work:\n${lines.join("\n")}`;
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeSummary(value?: string): string {
  return compactWhitespace(String(value || "").toLowerCase());
}

function tokenize(value?: string): string[] {
  return normalizeSummary(value)
    .split(/[^a-z0-9_./-]+/i)
    .map((token) => token.trim())
    .filter(Boolean);
}

function jaccardOverlap(left?: string, right?: string): number {
  const leftTokens = new Set(tokenize(left));
  const rightTokens = new Set(tokenize(right));
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) intersection += 1;
  }
  const union = new Set([...leftTokens, ...rightTokens]).size;
  return union > 0 ? intersection / union : 0;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("timeout"));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

function extractTimestamp(metadata?: Record<string, unknown>): number {
  const candidates = [
    metadata?.updatedAt,
    metadata?.createdAt,
    metadata?.timestamp,
    metadata?.event_date,
    metadata?.eventDate,
  ];
  for (const value of candidates) {
    if (typeof value === "string") {
      const parsed = Date.parse(value);
      if (!Number.isNaN(parsed)) return parsed;
    }
  }
  return 0;
}

const DEFAULT_RANK_WEIGHTS: Required<AgentRuntimeRankWeights> = {
  focusedPassBonus: 0.2,
  sourceMatchBonus: 0.18,
  touchedFileBonus: 0.12,
  clientMatchBonus: 0.1,
  highSalienceBonus: 0.12,
  mediumSalienceBonus: 0.06,
  staleBroadPenalty: -0.1,
  unrelatedClientPenalty: -0.18,
  lowSaliencePenalty: -0.12,
};

const DEFAULT_SOURCE_ACTIVITY: Required<AgentRuntimeSourceActivityOptions> = {
  maxTurns: 10,
  maxIdleMs: 30 * 60 * 1000,
  decayAfterTurns: 5,
  decayAfterIdleMs: 15 * 60 * 1000,
  evictOnTaskSwitch: true,
};

interface FocusedScopeSignals {
  sourceIds: string[];
  fileHints: string[];
  clientName?: string;
}

interface SourceActivityEntry {
  sourceId: string;
  turn: number;
  at: number;
}

export class WhisperAgentRuntime {
  private readonly bindingStore: BindingStore;
  private readonly focusedTopK: number;
  private readonly broadTopK: number;
  private readonly maxTokens: number;
  private readonly targetRetrievalMs: number;
  private readonly hardRetrievalTimeoutMs: number;
  private readonly recentWorkLimit: number;
  private readonly baseContext: AgentRunContext;
  private readonly clientName: string;
  private readonly minFocusedResults: number;
  private readonly minFocusedTopScore: number;
  private readonly minProjectScore: number;
  private readonly minMemoryScore: number;
  private readonly rankWeights: Required<AgentRuntimeRankWeights>;
  private readonly sourceActivityOptions: Required<AgentRuntimeSourceActivityOptions>;
  private bindings: Record<string, string> | null = null;
  private touchedFiles: string[] = [];
  private recentWork: WorkEvent[] = [];
  private recentSourceActivity: SourceActivityEntry[] = [];
  private bufferedLowSalience: WorkEvent[] = [];
  private bufferedSessionEvents: WorkEvent[] = [];
  private lastPreparedTurn: PreparedTurn["retrieval"] | null = null;
  private mergedCount = 0;
  private droppedCount = 0;
  private focusedPassHits = 0;
  private fallbackTriggers = 0;
  private floorDroppedCount = 0;
  private injectedItemCount = 0;
  private sourceScopedTurns = 0;
  private broadScopedTurns = 0;
  private totalTurns = 0;
  private currentTurn = 0;
  private lastTaskSummary = "";
  private lastScope: AgentRuntimeStatus["scope"] = {};

  constructor(private readonly args: {
    baseContext: AgentRunContext;
    options: AgentRuntimeOptions;
    adapter: RuntimeAdapter;
  }) {
    this.bindingStore = createBindingStore(args.options.bindingStorePath);
    const retrieval = args.options.retrieval || {};
    this.focusedTopK = retrieval.focusedTopK ?? args.options.topK ?? 6;
    this.broadTopK = retrieval.broadTopK ?? Math.max(args.options.topK ?? 6, 10);
    this.maxTokens = args.options.maxTokens ?? 4000;
    this.targetRetrievalMs = args.options.targetRetrievalMs ?? 2500;
    this.hardRetrievalTimeoutMs = args.options.hardRetrievalTimeoutMs ?? 4000;
    this.recentWorkLimit = args.options.recentWorkLimit ?? 40;
    this.baseContext = args.baseContext;
    this.clientName = args.baseContext.clientName || "whisper-agent-runtime";
    this.minFocusedResults = retrieval.minFocusedResults ?? 3;
    this.minFocusedTopScore = retrieval.minFocusedTopScore ?? 0.55;
    this.minProjectScore = retrieval.minProjectScore ?? 0.5;
    this.minMemoryScore = retrieval.minMemoryScore ?? 0.6;
    this.rankWeights = { ...DEFAULT_RANK_WEIGHTS, ...(retrieval.rankWeights || {}) };
    this.sourceActivityOptions = { ...DEFAULT_SOURCE_ACTIVITY, ...(retrieval.sourceActivity || {}) };
  }

  private async getBindings(): Promise<Record<string, string>> {
    if (!this.bindings) {
      this.bindings = await this.bindingStore.load();
    }
    return this.bindings;
  }

  private pushTouchedFiles(paths?: string[]): void {
    if (!paths || paths.length === 0) return;
    for (const path of paths) {
      if (!path) continue;
      this.touchedFiles = [...this.touchedFiles.filter((entry) => entry !== path), path].slice(-20);
    }
  }

  private pushWorkEvent(event: WorkEvent): void {
    this.recentWork = [...this.recentWork, event].slice(-this.recentWorkLimit);
  }

  noteSourceActivity(sourceIds?: string[]): void {
    const now = Date.now();
    for (const sourceId of [...new Set((sourceIds || []).map((value) => String(value || "").trim()).filter(Boolean))]) {
      this.recentSourceActivity = [
        ...this.recentSourceActivity.filter((entry) => entry.sourceId !== sourceId),
        { sourceId, turn: this.currentTurn, at: now },
      ].slice(-24);
    }
  }

  private refreshTaskSummary(taskSummary?: string): void {
    const next = normalizeSummary(taskSummary);
    if (!next) return;
    if (
      this.sourceActivityOptions.evictOnTaskSwitch &&
      this.lastTaskSummary &&
      this.lastTaskSummary !== next &&
      jaccardOverlap(this.lastTaskSummary, next) < 0.6
    ) {
      this.recentSourceActivity = [];
    }
    this.lastTaskSummary = next;
  }

  private activeSourceIds(): string[] {
    const now = Date.now();
    const active = new Map<string, number>();
    const maxTurns = this.sourceActivityOptions.maxTurns;
    const maxIdleMs = this.sourceActivityOptions.maxIdleMs;
    const decayAfterTurns = this.sourceActivityOptions.decayAfterTurns;
    const decayAfterIdleMs = this.sourceActivityOptions.decayAfterIdleMs;
    const fresh: SourceActivityEntry[] = [];

    for (const entry of this.recentSourceActivity) {
      const turnDelta = this.currentTurn - entry.turn;
      const idleDelta = now - entry.at;
      if (turnDelta > maxTurns || idleDelta > maxIdleMs) continue;
      fresh.push(entry);
      let weight = 1;
      if (turnDelta > decayAfterTurns || idleDelta > decayAfterIdleMs) {
        weight = 0.5;
      }
      const current = active.get(entry.sourceId) || 0;
      active.set(entry.sourceId, Math.max(current, weight));
    }

    this.recentSourceActivity = fresh.slice(-24);
    return [...active.entries()]
      .sort((left, right) => right[1] - left[1])
      .map(([sourceId]) => sourceId)
      .slice(0, 4);
  }

  private focusedScope(input: TurnInput): FocusedScopeSignals {
    const sourceIds = this.activeSourceIds();
    const fileHints = [...new Set([
      ...(input.touchedFiles || []),
      ...this.touchedFiles,
      ...this.recentWork.flatMap((event) => event.filePaths || []),
    ].map((value) => String(value || "").trim()).filter(Boolean))].slice(-4);
    return {
      sourceIds,
      fileHints,
      clientName: this.clientName || undefined,
    };
  }

  private exactFileMetadataFilter(fileHints: string[]): Record<string, unknown> | undefined {
    const exact = fileHints.find((value) => /[\\/]/.test(value));
    if (!exact) return undefined;
    return { filePath: exact };
  }

  private makeTaskFrameQuery(input: TurnInput): string | null {
    const task = compactWhitespace(input.taskSummary || "");
    const salient = this.recentWork
      .filter((event) => event.salience === "high")
      .slice(-3)
      .map((event) => `${event.kind}: ${event.summary}`);
    const files = [...(input.touchedFiles || []), ...this.touchedFiles]
      .slice(-3)
      .map((file) => pathBase(file));
    const parts = [
      task ? `task ${task}` : "",
      salient.length > 0 ? `recent ${salient.join(" ; ")}` : "",
      files.length > 0 ? `files ${files.join(" ")}` : "",
      input.toolContext ? `tool context ${compactWhitespace(input.toolContext)}` : "",
    ].filter(Boolean);
    if (parts.length === 0) return null;
    return parts.join(" | ");
  }

  private async resolveScope(overrides?: Partial<AgentRunContext>): Promise<{
    scope: AgentRunContext & { project: string; userId: string; sessionId: string };
    projectSource: "explicit" | "workspace" | "config" | "generated";
    warning?: string;
  }> {
    const merged: AgentRunContext = {
      ...this.baseContext,
      ...overrides,
    };
    const normalizedWorkspace = normalizeWorkspacePath(merged.workspacePath);
    const bindings = await this.getBindings();
    const workspaceProject = normalizedWorkspace ? bindings[normalizedWorkspace] : undefined;
    const configuredProject = merged.project;
    let projectRef = configuredProject;
    let projectSource: "explicit" | "workspace" | "config" | "generated" = overrides?.project ? "explicit" : "generated";
    let warning: string | undefined;

    if (workspaceProject) {
      projectRef = workspaceProject;
      projectSource = "workspace";
      if (configuredProject && workspaceProject !== configuredProject) {
        warning = `workspace mapping '${workspaceProject}' overrides configured project '${configuredProject}'`;
      }
    } else if (configuredProject) {
      projectRef = configuredProject;
      projectSource = overrides?.project ? "explicit" : "config";
    }

    const project = (await this.args.adapter.resolveProject(projectRef)).id;
    if (normalizedWorkspace) {
      bindings[normalizedWorkspace] = project;
      await this.bindingStore.save(bindings);
    }

    const scope = {
      ...merged,
      project,
      userId: merged.userId || `${this.clientName}-user`,
      sessionId: merged.sessionId || `sess_${stableHash(`${this.clientName}_${normalizedWorkspace || "default"}`)}`,
      agentId: merged.agentId || this.clientName,
      taskId: merged.taskId,
    };
    this.lastScope = {
      project: scope.project,
      userId: scope.userId,
      sessionId: scope.sessionId,
      agentId: scope.agentId,
      taskId: scope.taskId,
      source: projectSource,
      warning,
    };
    return { scope, projectSource, warning };
  }

  private async runBranch<T>(name: string, task: () => Promise<T>): Promise<BranchResult<T>> {
    const startedAt = Date.now();
    try {
      const value = await withTimeout(task(), this.hardRetrievalTimeoutMs);
      return {
        name,
        status: "ok",
        durationMs: Date.now() - startedAt,
        value,
      };
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const reason = error instanceof Error ? error.message : String(error);
      return {
        name,
        status: reason === "timeout" ? "timeout" : "error",
        durationMs,
        reason,
      };
    }
  }

  private contextItems(
    result: QueryResult,
    sourceQuery: RankedItem["sourceQuery"],
    pass: RankedItem["pass"],
  ): RankedItem[] {
    const sourceScope = result.meta?.source_scope;
    if (sourceScope?.mode === "auto" || sourceScope?.mode === "explicit") {
      this.noteSourceActivity(sourceScope.source_ids || []);
    }
    return (result.results || []).map((item) => ({
      id: item.id,
      content: item.content,
      type: "project",
      score: item.score ?? 0,
      sourceQuery,
      pass,
      metadata: item.metadata || {},
    }));
  }

  private memoryItems(
    result: MemorySearchResponse,
    sourceQuery: RankedItem["sourceQuery"],
    pass: RankedItem["pass"],
  ): RankedItem[] {
    return (result.results || []).map((item, index) => ({
      id: item.memory?.id || item.chunk?.id || `${sourceQuery}_memory_${index}`,
      content: item.chunk?.content || item.memory?.content || "",
      type: "memory" as const,
      score: item.similarity ?? 0,
      sourceQuery,
      pass,
      metadata: {
        ...(item.chunk?.metadata || {}),
        ...(item.memory?.temporal || {}),
        confidence: item.memory?.confidence,
      },
    })).filter((item) => item.content);
  }

  private stableItemKey(item: RankedItem): string {
    const metadata = item.metadata || {};
    const sourceId = String(metadata.source_id || "");
    const documentId = String(metadata.document_id || metadata.documentId || "");
    const chunkId = String(metadata.chunk_id || metadata.chunkId || item.id || "");
    return stableHash(`${sourceId}|${documentId}|${chunkId}|${item.content.slice(0, 256)}`);
  }

  private metadataStrings(item: RankedItem): string[] {
    const metadata = item.metadata || {};
    return [
      metadata.filePath,
      metadata.file_path,
      metadata.path,
      metadata.section_path,
      metadata.parent_section_path,
      metadata.web_url,
      metadata.url,
    ]
      .map((value) => String(value || "").toLowerCase())
      .filter(Boolean);
  }

  private hasSourceMatch(item: RankedItem, scope: FocusedScopeSignals): boolean {
    const sourceId = String(item.metadata?.source_id || "");
    return Boolean(sourceId && scope.sourceIds.includes(sourceId));
  }

  private hasFileMatch(item: RankedItem, scope: FocusedScopeSignals): boolean {
    if (scope.fileHints.length === 0) return false;
    const metadata = this.metadataStrings(item);
    const lowerHints = scope.fileHints.map((hint) => hint.toLowerCase());
    return lowerHints.some((hint) => {
      const base = pathBase(hint).toLowerCase();
      return metadata.some((value) => value.includes(hint) || value.endsWith(base));
    });
  }

  private hasClientMatch(item: RankedItem, scope: FocusedScopeSignals): boolean {
    const itemClient = String(item.metadata?.client_name || "");
    return Boolean(scope.clientName && itemClient && itemClient === scope.clientName);
  }

  private salienceAdjustment(item: RankedItem): number {
    const salience = item.metadata?.salience;
    if (salience === "high") return this.rankWeights.highSalienceBonus;
    if (salience === "medium") return this.rankWeights.mediumSalienceBonus;
    if (salience === "low") return this.rankWeights.lowSaliencePenalty;
    return 0;
  }

  private narrowFocusedMemories(items: RankedItem[], scope: FocusedScopeSignals): RankedItem[] {
    // TODO: move this narrowing server-side when memory search supports metadata_filter.
    const hasSignals = scope.sourceIds.length > 0 || scope.fileHints.length > 0 || Boolean(scope.clientName);
    if (!hasSignals) return items;
    const narrowed = items.filter((item) => {
      const matchesClient = this.hasClientMatch(item, scope);
      const matchesFile = this.hasFileMatch(item, scope);
      const matchesSource = this.hasSourceMatch(item, scope);
      const salience = item.metadata?.salience;
      if (scope.clientName && item.metadata?.client_name && !matchesClient) {
        return false;
      }
      if (salience === "low" && !matchesFile && !matchesSource) {
        return false;
      }
      return matchesClient || matchesFile || matchesSource || !scope.clientName;
    });
    return narrowed.length > 0 ? narrowed : items;
  }

  private applyRelevanceFloor(items: RankedItem[]): { items: RankedItem[]; dropped: number } {
    const filtered = items.filter((item) =>
      item.type === "project"
        ? item.score >= this.minProjectScore
        : item.score >= this.minMemoryScore
    );
    return { items: filtered, dropped: Math.max(0, items.length - filtered.length) };
  }

  private rerank(items: RankedItem[], scope: FocusedScopeSignals): { items: RankedItem[]; dedupedCount: number } {
    const deduped = new Map<string, RankedItem>();
    for (const item of items) {
      const key = this.stableItemKey(item);
      const recency = extractTimestamp(item.metadata) > 0 ? 0.04 : 0;
      const queryBonus = item.sourceQuery === "primary" ? 0.08 : item.sourceQuery === "task_frame" ? 0.04 : 0.03;
      const sourceMatch = this.hasSourceMatch(item, scope);
      const fileMatch = this.hasFileMatch(item, scope);
      const clientMatch = this.hasClientMatch(item, scope);
      const broadPenalty =
        item.pass === "broad" && !sourceMatch && !fileMatch && !clientMatch
          ? this.rankWeights.staleBroadPenalty
          : 0;
      const clientPenalty =
        scope.clientName && item.metadata?.client_name && !clientMatch
          ? this.rankWeights.unrelatedClientPenalty
          : 0;
      const next: RankedItem = {
        ...item,
        score: clamp01(
          item.score +
          queryBonus +
          recency +
          (item.pass === "focused" ? this.rankWeights.focusedPassBonus : 0) +
          (sourceMatch ? this.rankWeights.sourceMatchBonus : 0) +
          (fileMatch ? this.rankWeights.touchedFileBonus : 0) +
          (clientMatch ? this.rankWeights.clientMatchBonus : 0) +
          this.salienceAdjustment(item) +
          broadPenalty +
          clientPenalty
        ),
      };
      const existing = deduped.get(key);
      if (!existing || next.score > existing.score) {
        deduped.set(key, next);
      }
    }
    return {
      items: [...deduped.values()].sort((left, right) => right.score - left.score),
      dedupedCount: Math.max(0, items.length - deduped.size),
    };
  }

  private buildContext(items: RankedItem[]): string {
    const maxChars = this.maxTokens * 4;
    const lines: string[] = [];
    let used = 0;
    for (const item of items) {
      const label = item.type === "memory" ? "memory" : "context";
      const content = compactWhitespace(item.content);
      if (!content) continue;
      const line = `[${label}] ${content}`;
      if (used + line.length > maxChars) break;
      lines.push(line);
      used += line.length;
    }
    if (lines.length === 0) return "";
    return `Relevant context:\n${lines.join("\n")}`;
  }

  async bootstrap(context: Partial<AgentRunContext> = {}): Promise<PreparedTurn> {
    const { scope, warning } = await this.resolveScope(context);
    const warnings = warning ? [warning] : [];
    const startedAt = Date.now();
    const branches = await Promise.all([
      this.runBranch("session_recent", () => this.args.adapter.getSessionMemories({
        project: scope.project,
        session_id: scope.sessionId,
        include_pending: true,
        limit: 12,
      })),
      this.runBranch("user_profile", () => scope.userId
        ? this.args.adapter.getUserProfile({
          project: scope.project,
          user_id: scope.userId,
          include_pending: true,
          memory_types: "preference,instruction,goal",
        })
        : Promise.resolve({ user_id: scope.userId, memories: [], count: 0 })),
      this.runBranch("project_rules", () => this.args.adapter.query({
        project: scope.project,
        query: "project rules instructions constraints conventions open threads",
        top_k: this.focusedTopK,
        include_memories: false,
        user_id: scope.userId,
        session_id: scope.sessionId,
        max_tokens: this.maxTokens,
        compress: true,
        compression_strategy: "adaptive",
      })),
    ]);

    const items: RankedItem[] = [];
    const branchStatus: PreparedTurn["retrieval"]["branchStatus"] = {};
    for (const branch of branches) {
      branchStatus[branch.name] = branch.status;
      if (branch.status !== "ok") {
        if (branch.reason) warnings.push(`${branch.name}:${branch.reason}`);
        continue;
      }
      if (branch.name === "project_rules") {
        items.push(...this.contextItems(branch.value as QueryResult, "bootstrap", "bootstrap"));
        continue;
      }
      const records = (branch.value as { memories?: Array<Record<string, unknown>> }).memories || [];
      items.push(...records.map((memory, index) => ({
        id: String(memory.id || `${branch.name}_${index}`),
        content: String(memory.content || ""),
        type: "memory" as const,
        score: 0.4,
        sourceQuery: "bootstrap" as const,
        pass: "bootstrap" as const,
        metadata: memory,
      })).filter((item) => item.content));
    }

    const reranked = this.rerank(items, { sourceIds: [], fileHints: [], clientName: this.clientName });
    const ranked = reranked.items.slice(0, this.broadTopK * 2);
    const prepared: PreparedTurn = {
      scope,
      retrieval: {
        primaryQuery: "bootstrap",
        taskFrameQuery: null,
        warnings,
        degraded: warnings.length > 0,
        degradedReason: warnings.length > 0 ? "partial_bootstrap" : undefined,
        durationMs: Date.now() - startedAt,
        targetBudgetMs: this.targetRetrievalMs,
        hardTimeoutMs: this.hardRetrievalTimeoutMs,
        branchStatus,
        focusedScopeApplied: false,
        focusedSourceIds: [],
        focusedFileHints: [],
        clientScoped: false,
        fallbackUsed: false,
        droppedBelowFloor: 0,
        dedupedCount: reranked.dedupedCount,
      },
      context: this.buildContext(ranked),
      items: ranked,
    };
    this.lastPreparedTurn = prepared.retrieval;
    return prepared;
  }

  async beforeTurn(input: TurnInput, context: Partial<AgentRunContext> = {}): Promise<PreparedTurn> {
    this.currentTurn += 1;
    this.pushTouchedFiles(input.touchedFiles);
    this.refreshTaskSummary(input.taskSummary);
    const { scope, warning } = await this.resolveScope(context);
    const primaryQuery = compactWhitespace(input.userMessage);
    const taskFrameQuery = this.makeTaskFrameQuery(input);
    const focusedScope = this.focusedScope(input);
    const focusedMetadataFilter = this.exactFileMetadataFilter(focusedScope.fileHints);
    const focusedScopeApplied =
      focusedScope.sourceIds.length > 0 ||
      focusedScope.fileHints.length > 0 ||
      Boolean(focusedScope.clientName);
    const warnings = warning ? [warning] : [];
    const startedAt = Date.now();
    const branchStatus: PreparedTurn["retrieval"]["branchStatus"] = {};
    const collectFromBranches = (branches: Array<BranchResult<QueryResult | MemorySearchResponse>>, pass: RankedItem["pass"]) => {
      const collected: RankedItem[] = [];
      let okCount = 0;
      for (const branch of branches) {
        branchStatus[branch.name] = branch.status;
        if (branch.status !== "ok") {
          if (branch.status !== "skipped" && branch.reason) warnings.push(`${branch.name}:${branch.reason}`);
          continue;
        }
        okCount += 1;
        if (branch.name.startsWith("context")) {
          collected.push(...this.contextItems(
            branch.value as QueryResult,
            branch.name.includes("task_frame") ? "task_frame" : "primary",
            pass,
          ));
        } else {
          const memoryItems = this.memoryItems(
            branch.value as MemorySearchResponse,
            branch.name.includes("task_frame") ? "task_frame" : "primary",
            pass,
          );
          collected.push(...(pass === "focused" ? this.narrowFocusedMemories(memoryItems, focusedScope) : memoryItems));
        }
      }
      return { collected, okCount };
    };

    const focusedBranches = await Promise.all([
      this.runBranch("context_primary_focused", () => this.args.adapter.query({
        project: scope.project,
        query: primaryQuery,
        top_k: this.focusedTopK,
        include_memories: false,
        user_id: scope.userId,
        session_id: scope.sessionId,
        source_ids: focusedScope.sourceIds.length > 0 ? focusedScope.sourceIds : undefined,
        metadata_filter: focusedMetadataFilter,
        max_tokens: this.maxTokens,
        compress: true,
        compression_strategy: "adaptive",
      })),
      this.runBranch("memory_primary_focused", () => this.args.adapter.searchMemories({
        project: scope.project,
        query: primaryQuery,
        user_id: scope.userId,
        session_id: scope.sessionId,
        agent_id: scope.agentId,
        task_id: scope.taskId,
        top_k: this.focusedTopK,
        include_pending: true,
        profile: "balanced",
      })),
      taskFrameQuery
        ? this.runBranch("context_task_frame_focused", () => this.args.adapter.query({
          project: scope.project,
          query: taskFrameQuery,
          top_k: this.focusedTopK,
          include_memories: false,
          user_id: scope.userId,
          session_id: scope.sessionId,
          source_ids: focusedScope.sourceIds.length > 0 ? focusedScope.sourceIds : undefined,
          metadata_filter: focusedMetadataFilter,
          max_tokens: this.maxTokens,
          compress: true,
          compression_strategy: "adaptive",
        }))
        : Promise.resolve<BranchResult<QueryResult>>({ name: "context_task_frame_focused", status: "skipped", durationMs: 0 }),
      taskFrameQuery
        ? this.runBranch("memory_task_frame_focused", () => this.args.adapter.searchMemories({
          project: scope.project,
          query: taskFrameQuery,
          user_id: scope.userId,
          session_id: scope.sessionId,
          agent_id: scope.agentId,
          task_id: scope.taskId,
          top_k: this.focusedTopK,
          include_pending: true,
          profile: "balanced",
        }))
        : Promise.resolve<BranchResult<MemorySearchResponse>>({ name: "memory_task_frame_focused", status: "skipped", durationMs: 0 }),
    ]);

    const focusedCollected = collectFromBranches(focusedBranches, "focused");
    const focusedRanked = this.rerank(focusedCollected.collected, focusedScope);
    const focusedFloored = this.applyRelevanceFloor(focusedRanked.items);
    let allCollected = [...focusedFloored.items];
    let totalOkCount = focusedCollected.okCount;
    let dedupedCount = focusedRanked.dedupedCount;
    let droppedBelowFloor = focusedFloored.dropped;
    const focusedTopScore = focusedFloored.items[0]?.score ?? 0;
    const fallbackUsed =
      focusedFloored.items.length < this.minFocusedResults ||
      focusedTopScore < this.minFocusedTopScore;

    if (focusedScopeApplied) {
      this.sourceScopedTurns += 1;
    }
    if (!fallbackUsed) {
      this.focusedPassHits += 1;
    }

    const broadBranches = fallbackUsed
      ? await Promise.all([
        this.runBranch("context_primary_broad", () => this.args.adapter.query({
          project: scope.project,
          query: primaryQuery,
          top_k: this.broadTopK,
          include_memories: false,
          user_id: scope.userId,
          session_id: scope.sessionId,
          max_tokens: this.maxTokens,
          compress: true,
          compression_strategy: "adaptive",
        })),
        this.runBranch("memory_primary_broad", () => this.args.adapter.searchMemories({
          project: scope.project,
          query: primaryQuery,
          user_id: scope.userId,
          session_id: scope.sessionId,
          agent_id: scope.agentId,
          task_id: scope.taskId,
          top_k: this.broadTopK,
          include_pending: true,
          profile: "balanced",
        })),
        taskFrameQuery
          ? this.runBranch("context_task_frame_broad", () => this.args.adapter.query({
            project: scope.project,
            query: taskFrameQuery,
            top_k: this.broadTopK,
            include_memories: false,
            user_id: scope.userId,
            session_id: scope.sessionId,
            max_tokens: this.maxTokens,
            compress: true,
            compression_strategy: "adaptive",
          }))
          : Promise.resolve<BranchResult<QueryResult>>({ name: "context_task_frame_broad", status: "skipped", durationMs: 0 }),
        taskFrameQuery
          ? this.runBranch("memory_task_frame_broad", () => this.args.adapter.searchMemories({
            project: scope.project,
            query: taskFrameQuery,
            user_id: scope.userId,
            session_id: scope.sessionId,
            agent_id: scope.agentId,
            task_id: scope.taskId,
            top_k: this.broadTopK,
            include_pending: true,
            profile: "balanced",
          }))
          : Promise.resolve<BranchResult<MemorySearchResponse>>({ name: "memory_task_frame_broad", status: "skipped", durationMs: 0 }),
      ])
      : [
        { name: "context_primary_broad", status: "skipped", durationMs: 0 } as BranchResult<QueryResult>,
        { name: "memory_primary_broad", status: "skipped", durationMs: 0 } as BranchResult<MemorySearchResponse>,
        { name: "context_task_frame_broad", status: "skipped", durationMs: 0 } as BranchResult<QueryResult>,
        { name: "memory_task_frame_broad", status: "skipped", durationMs: 0 } as BranchResult<MemorySearchResponse>,
      ];

    const broadCollected = collectFromBranches(broadBranches, "broad");
    totalOkCount += broadCollected.okCount;
    if (fallbackUsed) {
      this.fallbackTriggers += 1;
      this.broadScopedTurns += 1;
      allCollected = [...allCollected, ...broadCollected.collected];
    }

    const ranked = this.rerank(allCollected, focusedScope);
    dedupedCount += ranked.dedupedCount;
    const floored = this.applyRelevanceFloor(ranked.items);
    droppedBelowFloor += floored.dropped;
    this.floorDroppedCount += droppedBelowFloor;
    this.droppedCount += droppedBelowFloor;
    const finalItems = floored.items.slice(0, this.broadTopK);
    this.injectedItemCount += finalItems.length;
    this.totalTurns += 1;

    const executedBranches = [...focusedBranches, ...broadBranches].filter((branch) => branch.status !== "skipped");
    for (const branch of [...focusedBranches, ...broadBranches]) {
      branchStatus[branch.name] = branch.status;
    }
    const prepared: PreparedTurn = {
      scope,
      retrieval: {
        primaryQuery,
        taskFrameQuery,
        warnings,
        degraded: totalOkCount < executedBranches.length,
        degradedReason:
          totalOkCount === 0
            ? "all_retrieval_failed"
            : warnings.length > 0
              ? "partial_retrieval_failed"
              : undefined,
        durationMs: Date.now() - startedAt,
        targetBudgetMs: this.targetRetrievalMs,
        hardTimeoutMs: this.hardRetrievalTimeoutMs,
        branchStatus,
        focusedScopeApplied,
        focusedSourceIds: focusedScope.sourceIds,
        focusedFileHints: focusedScope.fileHints.map((value) => pathBase(value)),
        clientScoped: Boolean(focusedScope.clientName),
        fallbackUsed,
        droppedBelowFloor,
        dedupedCount,
      },
      context: this.buildContext(finalItems),
      items: finalItems,
    };
    this.lastPreparedTurn = prepared.retrieval;
    return prepared;
  }

  async recordWork(event: WorkEvent, context: Partial<AgentRunContext> = {}): Promise<MemoryWriteAck | { success: true; buffered: true }> {
    const normalized: WorkEvent = {
      ...event,
      salience: event.salience || defaultSalience(event.kind, event.success),
      timestamp: event.timestamp || nowIso(),
    };
    this.pushTouchedFiles(normalized.filePaths);
    this.pushWorkEvent(normalized);
    this.bufferedSessionEvents = [...this.bufferedSessionEvents, normalized].slice(-this.recentWorkLimit);

    if (normalized.salience === "low") {
      this.bufferedLowSalience = [...this.bufferedLowSalience, normalized].slice(-20);
      return { success: true, buffered: true };
    }
    return { success: true, buffered: true };
  }

  private async resolveLearningScope(overrides?: Partial<AgentRunContext>): Promise<{
    project: string;
    sessionId: string;
    userId?: string;
    agentId?: string;
    taskId?: string;
  }> {
    const merged: AgentRunContext = {
      ...this.baseContext,
      ...overrides,
    };
    const { scope } = await this.resolveScope(overrides);
    return {
      project: scope.project,
      sessionId: merged.sessionId || scope.sessionId,
      userId: merged.userId,
      agentId: merged.agentId || scope.agentId,
      taskId: merged.taskId || scope.taskId,
    };
  }

  async afterTurn(input: TurnInput & { assistantMessage: string; auto_learn?: boolean }, context: Partial<AgentRunContext> = {}): Promise<TurnCaptureResult> {
    this.pushTouchedFiles(input.touchedFiles);
    if (input.auto_learn === false) {
      return {
        success: true,
        sessionIngested: false,
        memoriesCreated: 0,
        relationsCreated: 0,
        invalidatedCount: 0,
        mergedCount: 0,
        droppedCount: 0,
        warnings: [],
      };
    }
    const scope = await this.resolveLearningScope(context);
    const pendingEvents = [...this.bufferedSessionEvents];
    const result = await this.args.adapter.ingestSession({
      project: scope.project,
      session_id: scope.sessionId,
      user_id: scope.userId,
      agent_id: scope.agentId,
      task_id: scope.taskId,
      messages: [
        { role: "user", content: input.userMessage, timestamp: nowIso() },
        { role: "assistant", content: input.assistantMessage, timestamp: nowIso() },
      ],
      events: pendingEvents.length > 0 ? pendingEvents : undefined,
      promotion_mode: "session_state_v1",
      write_mode: "async",
    });
    this.bufferedSessionEvents = [];
    this.bufferedLowSalience = [];
    this.mergedCount += result.memories_invalidated || 0;
    return {
      success: Boolean(result.success),
      sessionIngested: true,
      memoriesCreated: result.memories_created || 0,
      relationsCreated: result.relations_created || 0,
      invalidatedCount: result.memories_invalidated || 0,
      mergedCount: result.memories_invalidated || 0,
      droppedCount: 0,
      warnings: result.errors || [],
    };
  }

  async flush(reason = "manual", context: Partial<AgentRunContext> = {}): Promise<AgentRuntimeStatus> {
    if (this.bufferedSessionEvents.length > 0) {
      const { scope } = await this.resolveScope(context);
      await this.args.adapter.ingestSession({
        project: scope.project,
        user_id: scope.userId,
        session_id: scope.sessionId,
        agent_id: scope.agentId,
        task_id: scope.taskId,
        messages: [],
        events: [...this.bufferedSessionEvents],
        promotion_mode: "session_state_v1",
        write_mode: "async",
      });
      this.bufferedSessionEvents = [];
      this.bufferedLowSalience = [];
    }
    await this.args.adapter.flushQueue();
    return this.status();
  }

  status(): AgentRuntimeStatus {
    return {
      clientName: this.clientName,
      scope: this.lastScope,
      queue: this.args.adapter.queueStatus(),
      retrieval: this.lastPreparedTurn,
      counters: {
        mergedCount: this.mergedCount,
        droppedCount: this.droppedCount,
        bufferedLowSalience: this.bufferedLowSalience.length,
        focusedPassHits: this.focusedPassHits,
        fallbackTriggers: this.fallbackTriggers,
        floorDroppedCount: this.floorDroppedCount,
        injectedItemCount: this.injectedItemCount,
        sourceScopedTurns: this.sourceScopedTurns,
        broadScopedTurns: this.broadScopedTurns,
        totalTurns: this.totalTurns,
      },
    };
  }
}
