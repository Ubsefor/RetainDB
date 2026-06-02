export type LocalBrainMemory = {
  id: string;
  content: string;
  memory_type: string;
  project: string;
  session_id?: string;
  agent_id?: string;
  task_id?: string;
  importance?: number;
  confidence?: number;
  created_at: string;
  updated_at?: string;
  active?: boolean;
  metadata?: Record<string, unknown>;
};

export type LocalBrainSession = {
  id?: string;
  project: string;
  memory_count: number;
  last_seen?: string;
  summary?: string;
};

export type LocalBrainSnapshot = {
  stats?: Record<string, unknown>;
  projects?: Array<{ id: string; name: string; slug: string }>;
  memories: LocalBrainMemory[];
  sessions?: LocalBrainSession[];
  type_counts?: Record<string, number>;
};

export type BrainFile = {
  path: string;
  absolutePath: string;
  kind: "summary" | "memory" | "session" | "agent" | "handoff" | "inbox" | "meta";
  bytes: number;
  updatedAt: string;
  content?: string;
};

export type BrainWriteInput = {
  cwd?: string;
  project?: string;
  agentId?: string;
  sessionId?: string;
  taskId?: string;
  title?: string;
  content: string;
  kind?: "note" | "handoff" | "decision" | "task" | "file_edit" | "failure";
  toAgentId?: string;
  files?: string[];
};
