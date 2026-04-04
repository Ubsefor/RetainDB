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
  | "workflow"
  | "episodic"
  | "semantic"
  | "procedural";

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

export interface MemoryLatencyBreakdown {
  cache_ms: number;
  embed_ms: number;
  vector_ms: number;
  lexical_ms: number;
  merge_ms: number;
  total_ms: number;
}

export interface MemorySearchResult {
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
  similarity: number;
  relations?: Array<Record<string, unknown>>;
  chunk?: {
    id: string;
    content: string;
    metadata?: Record<string, unknown>;
  };
}

export interface MemorySearchResponse {
  results: MemorySearchResult[];
  count: number;
  query: string;
  trace_id?: string;
  latency_ms?: number;
  latency_breakdown?: MemoryLatencyBreakdown;
  fallback?: "vector" | "lexical";
  mode?: "fast" | "balanced" | "quality";
  profile?: "fast" | "balanced" | "quality";
  include_pending?: boolean;
  pending_overlay_count?: number;
  cache_hit?: boolean;
}

export interface MemoryWriteAck {
  success: boolean;
  mode?: "async" | "sync";
  trace_id?: string;
  memory_id?: string;
  job_id?: string;
  status_url?: string;
  accepted_at?: string;
  visibility_sla_ms?: number;
  pending_visibility?: boolean;
  semantic_status?: "pending" | "ready";
  queued?: boolean;
  event_id?: string;
  created?: number;
  errors?: string[];
}

export type LearnIngestionProfile =
  | "auto"
  | "repo"
  | "web_docs"
  | "pdf_layout"
  | "video_transcript"
  | "plain_text";

export type LearnStrategyOverride =
  | "fixed"
  | "recursive"
  | "semantic"
  | "hierarchical"
  | "adaptive";

export type LearnSourceType =
  | "github"
  | "web"
  | "playwright"
  | "pdf"
  | "local"
  | "slack"
  | "video";

export interface LearnConversationInput {
  mode: "conversation";
  project?: string;
  user_id?: string;
  agent_id?: string;
  task_id?: string;
  session_id: string;
  messages: Array<{
    role: string;
    content: string;
    timestamp?: string;
  }>;
  events?: SessionWorkEvent[];
  promotion_mode?: PromotionMode;
}

export interface LearnTextInput {
  mode: "text";
  project?: string;
  title: string;
  content: string;
  metadata?: Record<string, unknown>;
  tags?: string[];
  namespace?: string;
  options?: {
    async?: boolean;
    ingestion_profile?: LearnIngestionProfile;
    strategy_override?: LearnStrategyOverride;
    profile_config?: Record<string, unknown>;
  };
}

export interface LearnSourceInput {
  mode: "source";
  project?: string;
  type: LearnSourceType;
  name?: string;
  metadata?: Record<string, string>;
  owner?: string;
  repo?: string;
  branch?: string;
  paths?: string[];
  url?: string;
  file_path?: string;
  path?: string;
  channel_ids?: string[];
  since?: string;
  token?: string;
  auth_ref?: string;
  platform?: "youtube" | "loom" | "generic";
  language?: string;
  options?: {
    async?: boolean;
    auto_index?: boolean;
    ingestion_profile?: LearnIngestionProfile;
    strategy_override?: LearnStrategyOverride;
    profile_config?: Record<string, unknown>;
    crawl_depth?: number;
    include_paths?: string[];
    exclude_paths?: string[];
    glob?: string;
    max_files?: number;
    max_pages?: number;
    extract_mode?: "text" | "structured" | "markdown";
    workspace_id?: string;
    allow_stt_fallback?: boolean;
    max_duration_minutes?: number;
    max_chunks?: number;
  };
}

export type LearnInput =
  | LearnConversationInput
  | LearnTextInput
  | LearnSourceInput;

export interface LearnConversationResult {
  success: true;
  mode: "conversation";
  project: string;
  scope_mode: "user_session" | "session_only";
  scope_counts?: Partial<Record<MemoryScopeTarget, number>>;
  scopes_touched?: MemoryScopeTarget[];
  memories_created: number;
  relations_created: number;
  memories_invalidated: number;
  errors?: string[];
}

export interface LearnTextResult {
  success: true;
  mode: "text";
  project: string;
  status: "processing" | "completed";
  job_id?: string | null;
  chunks_indexed?: number;
  source_id?: string | null;
}

export interface LearnSourceResult {
  success: true;
  mode: "source";
  project: string;
  source_id: string;
  status: string;
  job_id?: string | null;
  index_started: boolean;
}

export type LearnResult =
  | LearnConversationResult
  | LearnTextResult
  | LearnSourceResult;
