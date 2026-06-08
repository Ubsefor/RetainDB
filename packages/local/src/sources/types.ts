export type SourceStatus = "connected" | "syncing" | "idle" | "error" | "deleted";

export type SourceType =
  | "web"
  | "url"
  | "sitemap"
  | "github"
  | "slack"
  | "notion"
  | "confluence"
  | "local_files";

export type SourceConfig = Record<string, unknown>;

export interface Source {
  id: string;
  type: SourceType;
  name: string;
  project: string;
  config: SourceConfig;
  status: SourceStatus;
  created_at: string;
  updated_at: string;
  last_synced_at?: string;
  last_sync_status?: "ok" | "partial" | "error";
  last_sync_summary?: {
    documents_indexed: number;
    memories_created: number;
    errors: number;
    duration_ms: number;
  };
  last_error?: string;
}

export interface IngestedDocument {
  external_id: string;
  title: string;
  content: string;
  source_type: SourceType;
  metadata: Record<string, unknown>;
}

export interface SyncProgress {
  stage: "fetching" | "extracting" | "indexing" | "done";
  current: number;
  total: number;
  message: string;
}

export interface SyncResult {
  documents_indexed: number;
  memories_created: number;
  errors: string[];
  truncated: boolean;
  duration_ms: number;
  citations: Array<{ id: string; title: string }>;
}
