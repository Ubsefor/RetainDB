import type { LocalBrainMemory, LocalBrainSnapshot } from "./types.js";

export type RenderedBrainFile = {
  path: string;
  content: string;
};

const MAX_ITEMS = 80;

export function renderBrainFiles(snapshot: LocalBrainSnapshot, project = "default"): RenderedBrainFile[] {
  const memories = snapshot.memories.filter((memory) => memory.active !== false);
  const byType = (pattern: RegExp) => memories.filter((memory) => pattern.test(memory.memory_type));
  const agents = groupBy(memories.filter((memory) => memory.agent_id), (memory) => memory.agent_id || "agent");
  const sessions = snapshot.sessions || [];

  return [
    { path: "/README.md", content: renderReadme(snapshot, project, memories) },
    { path: "/memories/recent.md", content: renderMemoryList("Recent Memories", memories) },
    { path: "/memories/decisions.md", content: renderMemoryList("Decisions and Constraints", byType(/decision|constraint|semantic|correction/i)) },
    { path: "/memories/workflows.md", content: renderMemoryList("Workflows", byType(/workflow|procedural/i)) },
    { path: "/sessions/index.md", content: renderSessions(sessions) },
    { path: "/agents/index.md", content: renderAgents(agents) },
    { path: "/handoffs/README.md", content: renderHandoffReadme() },
    { path: "/inbox/README.md", content: renderInboxReadme() },
  ];
}

function renderReadme(snapshot: LocalBrainSnapshot, project: string, memories: LocalBrainMemory[]) {
  const stats = snapshot.stats || {};
  const recent = memories.slice(0, 8).map((memory) => `- ${headline(memory)} (${memory.memory_type})`);
  return [
    "# RetainDB Local Brain",
    "",
    `Project: ${project}`,
    `Memories: ${stats.memories ?? memories.length}`,
    `Sessions: ${snapshot.sessions?.length ?? 0}`,
    "",
    "## Agent Instructions",
    "",
    "- Read this file before starting a task.",
    "- Read `/memories/decisions.md` before changing architecture.",
    "- Write handoffs to `/inbox/` when another agent should continue.",
    "- Cite memory IDs or file paths when using this context.",
    "",
    "## Recent Context",
    "",
    ...(recent.length ? recent : ["- No memories yet."]),
    "",
    "## Folders",
    "",
    "- `/memories/` durable facts, decisions, corrections, and workflows.",
    "- `/sessions/` recent session summaries.",
    "- `/agents/` agent-scoped working memory.",
    "- `/handoffs/` shared handoff conventions.",
    "- `/inbox/` append-only notes and handoffs written by agents.",
    "",
  ].join("\n");
}

function renderMemoryList(title: string, memories: LocalBrainMemory[]) {
  const lines = [`# ${title}`, ""];
  for (const memory of memories.slice(0, MAX_ITEMS)) {
    lines.push(`## ${headline(memory)}`);
    lines.push("");
    lines.push(memory.content.trim());
    lines.push("");
    lines.push(`- id: ${memory.id}`);
    lines.push(`- type: ${memory.memory_type}`);
    if (memory.agent_id) lines.push(`- agent: ${memory.agent_id}`);
    if (memory.session_id) lines.push(`- session: ${memory.session_id}`);
    if (memory.task_id) lines.push(`- task: ${memory.task_id}`);
    lines.push(`- created: ${memory.created_at}`);
    lines.push("");
  }
  if (lines.length === 2) lines.push("No matching memories yet.", "");
  return lines.join("\n");
}

function renderSessions(sessions: NonNullable<LocalBrainSnapshot["sessions"]>) {
  const lines = ["# Sessions", ""];
  for (const session of sessions.slice(0, MAX_ITEMS)) {
    lines.push(`## ${session.id}`);
    lines.push("");
    lines.push(`- project: ${session.project}`);
    lines.push(`- memories: ${session.memory_count}`);
    if (session.last_seen) lines.push(`- last_seen: ${session.last_seen}`);
    if (session.summary) lines.push("", session.summary.trim(), "");
  }
  if (lines.length === 2) lines.push("No sessions yet.", "");
  return lines.join("\n");
}

function renderAgents(groups: Map<string, LocalBrainMemory[]>) {
  const lines = ["# Agents", ""];
  for (const [agent, memories] of groups) {
    lines.push(`## ${agent}`, "");
    for (const memory of memories.slice(0, 12)) lines.push(`- ${headline(memory)} (${memory.id})`);
    lines.push("");
  }
  if (lines.length === 2) lines.push("No agent-scoped memories yet.", "");
  return lines.join("\n");
}

function renderHandoffReadme() {
  return [
    "# Handoffs",
    "",
    "Use handoffs when one agent needs another agent to continue work.",
    "",
    "Write through the `files_write` MCP tool or `POST /v1/filesystem/write` with `kind: \"handoff\"`.",
    "RetainDB stores the handoff as both a file and durable local memory.",
    "",
  ].join("\n");
}

function renderInboxReadme() {
  return [
    "# Inbox",
    "",
    "Append-only notes from agents land here.",
    "Each file is safe to read by another agent and is also promoted into RetainDB memory.",
    "",
  ].join("\n");
}

function headline(memory: LocalBrainMemory) {
  return memory.content.split(/\r?\n/)[0]?.replace(/^[-#\s]+/, "").slice(0, 120) || memory.id;
}

function groupBy<T>(items: T[], keyFn: (item: T) => string) {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    map.set(key, [...(map.get(key) || []), item]);
  }
  return map;
}
