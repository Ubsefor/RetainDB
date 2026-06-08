// Company brain: aggregator that turns connector-ingested memories into a
// single, source-aware context for AI agents. Lives on the local server.

export type SourceType =
  | "web"
  | "url"
  | "sitemap"
  | "github"
  | "slack"
  | "notion"
  | "confluence"
  | "local_files"
  | "agent_brain"
  | "unknown";

export interface BrainMemory {
  id: string;
  content: string;
  memory_type?: string;
  metadata: Record<string, unknown>;
  created_at?: string;
  active?: boolean;
  importance?: number;
  confidence?: number;
  session_id?: string;
  agent_id?: string;
  source_id?: string;
  source_type?: SourceType;
  source_title?: string;
  external_id?: string;
  url?: string;
  citation?: { id: string; title: string; url?: string };
}

export interface Citation {
  id: string;
  memory_id: string;
  title: string;
  source_type: SourceType;
  source_id?: string;
  external_id?: string;
  url?: string;
  snippet: string;
  score?: number;
}

export interface SourceSection {
  source_id?: string;
  source_type: SourceType;
  title: string;
  memory_count: number;
  tokens: number;
  preview: string;
  memories: BrainMemory[];
}

export interface CompanyBrain {
  project: string;
  total_memories: number;
  total_sources: number;
  sources: SourceSection[];
  sources_index: Array<{ source_id?: string; source_type: SourceType; title: string; memory_count: number }>;
  text: string;
  citations: Citation[];
  generated_at: string;
}

export interface AskBrainOptions {
  project: string;
  query: string;
  top_k?: number;
  max_tokens?: number;
  include_agent_memories?: boolean;
}

export interface AskBrainResult {
  query: string;
  context: string;
  citations: Citation[];
  hits: number;
  total_tokens: number;
}

const NON_SOURCE_TYPES = new Set<SourceType>(["agent_brain", "local_files", "unknown"]);

function inferSourceType(memory: BrainMemory): SourceType {
  const fromMeta = (memory.source_type || (memory.metadata?.source_type as string)) as SourceType | undefined;
  if (fromMeta && typeof fromMeta === "string") return fromMeta as SourceType;
  const kind = (memory.metadata?.kind as string) || memory.memory_type;
  if (kind === "agent_brain" || memory.metadata?.source === "local_brain_file") return "agent_brain";
  if (kind === "local_files" || memory.metadata?.source === "filesystem_sync") return "local_files";
  return "unknown";
}

function sourceLabel(memory: BrainMemory): { source_id?: string; source_type: SourceType; title: string } {
  const source_type = inferSourceType(memory);
  const source_id = memory.source_id || (memory.metadata?.source_id as string | undefined);
  let title = memory.source_title || (memory.metadata?.source_title as string | undefined) || "Untitled source";
  if (!memory.source_title && !memory.metadata?.source_title) {
    if (source_type === "agent_brain") title = "Agent handoff notes";
    else if (source_type === "slack") title = "Slack";
    else if (source_type === "github") title = "GitHub";
    else if (source_type === "notion") title = "Notion";
    else if (source_type === "confluence") title = "Confluence";
    else if (source_type === "sitemap" || source_type === "url" || source_type === "web") title = "Web";
  }
  return { source_id, source_type, title };
}

function urlFor(memory: BrainMemory): string | undefined {
  const fromMeta = (memory.metadata?.url as string | undefined) || (memory.metadata?.source_url as string | undefined);
  if (fromMeta) return fromMeta;
  const meta = memory.metadata || {};
  if (meta.baseUrl && meta.pageId) return `${meta.baseUrl}/wiki${meta.url || ""}`;
  if (meta.channelId && meta.baseUrl) return `https://app.slack.com/client/${meta.baseUrl || ""}/${meta.channelId}`;
  return undefined;
}

function snippetOf(memory: BrainMemory, max = 280): string {
  const t = (memory.content || "").replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return t.slice(0, max) + "…";
}

export function memoryToCitation(memory: BrainMemory, score?: number): Citation {
  const { source_id, source_type, title } = sourceLabel(memory);
  return {
    id: `cite_${memory.id}`,
    memory_id: memory.id,
    title,
    source_type,
    source_id,
    external_id: memory.external_id || (memory.metadata?.external_id as string | undefined),
    url: urlFor(memory),
    snippet: snippetOf(memory),
    score,
  };
}

export function isFromSource(memory: BrainMemory): boolean {
  return !NON_SOURCE_TYPES.has(inferSourceType(memory));
}

function approxTokens(s: string): number {
  return Math.max(1, Math.ceil(s.length / 4));
}

export function groupBySource(memories: BrainMemory[]): SourceSection[] {
  const map = new Map<string, SourceSection>();
  for (const m of memories) {
    if (!isFromSource(m)) continue;
    const { source_id, source_type, title } = sourceLabel(m);
    const key = source_id || `${source_type}:${title}`;
    let section = map.get(key);
    if (!section) {
      section = { source_id, source_type, title, memory_count: 0, tokens: 0, preview: "", memories: [] };
      map.set(key, section);
    }
    section.memories.push(m);
    section.memory_count += 1;
    section.tokens += approxTokens(m.content || "");
  }
  const out = [...map.values()];
  for (const s of out) {
    s.memories.sort((a, b) => (b.importance || 0) - (a.importance || 0));
    s.preview = s.memories.slice(0, 2).map((m) => snippetOf(m, 200)).join(" · ");
  }
  out.sort((a, b) => b.memory_count - a.memory_count);
  return out;
}

export function buildCompanyBrain(input: {
  project: string;
  memories: BrainMemory[];
  maxTokens?: number;
}): CompanyBrain {
  const sections = groupBySource(input.memories);
  const totalMemories = sections.reduce((sum, s) => sum + s.memory_count, 0);
  const max = input.maxTokens ?? 8000;
  const lines: string[] = [];
  lines.push(`# Company brain — project: ${input.project}`);
  lines.push(`Sources: ${sections.length} · Memories: ${totalMemories}`);
  let used = approxTokens(lines.join("\n"));
  const citations: Citation[] = [];
  for (const s of sections) {
    if (used >= max) break;
    lines.push("");
    lines.push(`## ${s.title}  [${s.source_type}]  (${s.memory_count} memos)`);
    used += approxTokens(lines[lines.length - 1]);
    for (const m of s.memories) {
      if (used >= max) break;
      const bullet = `- ${snippetOf(m, 320)}  _(id: ${m.id})_`;
      lines.push(bullet);
      used += approxTokens(bullet);
      citations.push(memoryToCitation(m));
    }
  }
  return {
    project: input.project,
    total_memories: totalMemories,
    total_sources: sections.length,
    sources: sections,
    sources_index: sections.map((s) => ({ source_id: s.source_id, source_type: s.source_type, title: s.title, memory_count: s.memory_count })),
    text: lines.join("\n"),
    citations,
    generated_at: new Date().toISOString(),
  };
}

export interface AskMemorySearch {
  (input: { project: string; query: string; top_k: number }): Promise<{ memory: BrainMemory; score?: number }[]>;
}

export async function askBrain(opts: {
  project: string;
  query: string;
  top_k?: number;
  maxTokens?: number;
  includeAgentMemories?: boolean;
  search: AskMemorySearch;
}): Promise<AskBrainResult> {
  const topK = opts.top_k ?? 12;
  const maxTokens = opts.maxTokens ?? 2400;
  const includeAgent = opts.includeAgentMemories !== false;
  const hits = await opts.search({ project: opts.project, query: opts.query, top_k: topK });
  const filtered = hits.filter((h) => includeAgent ? true : isFromSource(h.memory));
  filtered.sort((a, b) => (b.score || 0) - (a.score || 0));
  const lines: string[] = [];
  lines.push(`# Q: ${opts.query}`);
  lines.push(`Relevant knowledge from the company brain (${filtered.length} hits):`);
  let used = approxTokens(lines.join("\n"));
  const citations: Citation[] = [];
  for (const h of filtered) {
    if (used >= maxTokens) break;
    const m = h.memory;
    const { source_type, title } = sourceLabel(m);
    const header = `- [${source_type}] ${title}`;
    const body = `  ${snippetOf(m, 320)}  _(id: ${m.id})_`;
    lines.push(header);
    lines.push(body);
    used += approxTokens(header) + approxTokens(body);
    citations.push(memoryToCitation(m, h.score));
  }
  return {
    query: opts.query,
    context: lines.join("\n"),
    citations,
    hits: filtered.length,
    total_tokens: used,
  };
}

export interface FeedAgentOptions {
  project: string;
  query?: string;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  maxContextTokens?: number;
  includeAgentMemories?: boolean;
  brain?: CompanyBrain;
  ask?: AskBrainResult;
}

export interface FeedAgentResult {
  system_prompt: string;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  citations: Citation[];
  context_tokens: number;
}

export function feedAgent(opts: FeedAgentOptions): FeedAgentResult {
  const maxCtx = opts.maxContextTokens ?? 2400;
  const includeAgent = opts.includeAgentMemories !== false;
  const sections: string[] = [];
  const citations: Citation[] = [];
  if (opts.ask) {
    sections.push(opts.ask.context);
    citations.push(...opts.ask.citations);
  } else if (opts.brain) {
    sections.push(opts.brain.text);
    citations.push(...opts.brain.citations);
  }
  let context = sections.join("\n\n---\n\n");
  if (approxTokens(context) > maxCtx) {
    let i = 0;
    while (approxTokens(context) > maxCtx && i < citations.length) citations.pop(), i++;
    const trimmed = buildCompanyBrain({
      project: opts.project,
      memories: citations.map((c) => ({
        id: c.memory_id,
        content: c.snippet,
        metadata: { source_type: c.source_type, source_id: c.source_id, source_title: c.title, external_id: c.external_id, url: c.url },
        source_id: c.source_id,
        source_type: c.source_type,
        source_title: c.title,
        external_id: c.external_id,
        url: c.url,
      })),
      maxTokens: maxCtx,
    });
    context = trimmed.text;
  }
  const system = [
    "You are an AI agent with access to a curated company brain. The following context was retrieved from the company's indexed sources (Slack, GitHub, Notion, Confluence, public web, and code).",
    "Use it as authoritative ground truth. When you cite a fact, mention the source in brackets (e.g. [slack:#design], [github:cli/cli@main:README.md]).",
    "If the context is insufficient, say so rather than guessing.",
    "",
    context,
  ].join("\n");
  const messages = [
    { role: "system" as const, content: system },
    ...opts.messages.filter((m) => m.role !== "system"),
  ];
  if (!includeAgent) {
    // best-effort: do not surface memories whose source_type is "agent_brain"
    // (already excluded by brain/ask filters).
  }
  return { system_prompt: system, messages, citations, context_tokens: approxTokens(context) };
}
