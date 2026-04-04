#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { spawnSync } from "child_process";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative, extname } from "path";
import { userInfo } from "os";
import { createHash } from "crypto";
import { RetainDBContext as WhisperContext } from "../sdk/index.js";
import {
  buildMcpSearchPayload,
  buildPrimaryToolSuccess,
  buildPrimaryToolError,
} from "./search-payload.mjs";

// ─── Config ────────────────────────────────────────────────────────────────

const API_KEY = process.env.RETAINDB_API_KEY || "";
const DEFAULT_PROJECT = process.env.RETAINDB_PROJECT || "";
const BASE_URL = process.env.RETAINDB_BASE_URL;

// ─── Client bootstrap ──────────────────────────────────────────────────────

function makeGuard<T extends object>(label: string): T {
  return new Proxy({} as T, {
    get(_t, prop) {
      if (typeof prop === "string" && !["then", "catch", "finally"].includes(prop)) {
        return async () => {
          throw new Error(`${label}: RETAINDB_API_KEY is not configured.`);
        };
      }
    },
  });
}

function makeClient(): WhisperContext {
  if (!API_KEY) return makeGuard<WhisperContext>("retaindb");
  return new WhisperContext({
    apiKey: API_KEY,
    project: DEFAULT_PROJECT,
    ...(BASE_URL ? { baseUrl: BASE_URL } : {}),
  });
}

const client = makeClient();
let cachedProject: string | undefined;

// ─── Server ────────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "retaindb",
  version: "1.0.0",
});

export function createMcpServer() {
  return server;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function ok(payload: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: JSON.stringify(buildPrimaryToolSuccess(payload), null, 2) }] };
}

function err(message: string) {
  return { content: [{ type: "text" as const, text: JSON.stringify(buildPrimaryToolError(message, { code: "tool_error" }), null, 2) }] };
}

async function resolveProject(explicit?: string): Promise<string> {
  if (explicit?.trim()) return explicit.trim();
  if (cachedProject) return cachedProject;
  try {
    const { projects } = await client.listProjects();
    const first = projects?.[0];
    if (first) {
      cachedProject = first.slug || first.name || first.id;
      return cachedProject;
    }
    // No projects exist — auto-create "default"
    const created = await client.createProject({ name: "default" });
    cachedProject = (created as any).slug || (created as any).name || "default";
    return cachedProject ?? "default";
  } catch {
    return DEFAULT_PROJECT || "default";
  }
}

function defaultUserId(): string {
  const explicit = process.env.RETAINDB_USER_ID;
  if (explicit?.trim()) return explicit.trim();
  try {
    const os = userInfo().username?.trim();
    if (os) return `mcp-${createHash("sha256").update(os).digest("hex").slice(0, 12)}`;
  } catch { /* */ }
  return "mcp-user";
}

// ─── File-system helpers (grep / read) ─────────────────────────────────────

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".next", "build", "__pycache__", ".turbo", "coverage", ".cache"]);

function* walkDir(dir: string, fileTypes?: string[]): Generator<string> {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walkDir(full, fileTypes);
    else if (entry.isFile()) {
      if (!fileTypes || fileTypes.length === 0) yield full;
      else if (fileTypes.includes(extname(entry.name).replace(".", ""))) yield full;
    }
  }
}

function readFileWindow(filePath: string, startLine = 1, endLine = 200): string {
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  const s = Math.max(1, startLine);
  const e = Math.max(s, endLine);
  return lines.slice(s - 1, e).map((line, i) => `${s + i}: ${line}`).join("\n") || "(empty)";
}

const CODE_EXTS = new Set(["ts", "tsx", "js", "jsx", "py", "go", "rs", "java", "cpp", "c", "cs", "rb", "php", "swift", "kt", "sql", "prisma", "graphql", "json", "yaml", "yml", "toml", "md", "mdx"]);

/**
 * Local codebase search — ripgrep when available, Node.js walkDir fallback.
 * Returns ranked file snippets for the given query terms.
 */
function searchLocalFiles(query: string, rootPath: string, topK = 10): Array<{ file: string; line: number; snippet: string; score: number }> {
  const results: Array<{ file: string; line: number; snippet: string; score: number }> = [];

  // Try ripgrep first (fast, handles large repos)
  const rgAvailable = spawnSync("rg", ["--version"], { stdio: "ignore" }).status === 0;
  if (rgAvailable) {
    try {
      const proc = spawnSync(
        "rg",
        ["--json", "-i", "-m", "3", "--max-filesize", "512K",
          "--glob", "!node_modules", "--glob", "!.git", "--glob", "!dist", "--glob", "!.next",
          "--", query, rootPath],
        { maxBuffer: 8 * 1024 * 1024 }
      );
      const output = (proc.stdout?.toString() ?? "");
      const fileScores = new Map<string, number>();
      for (const line of output.split("\n")) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          if (entry.type === "match") {
            const file = relative(rootPath, entry.data.path.text);
            const lineNum = entry.data.line_number as number;
            const snippet = (entry.data.lines.text as string).trimEnd();
            const prev = fileScores.get(file) ?? 0;
            fileScores.set(file, prev + 1);
            if (results.length < topK * 3) {
              results.push({ file, line: lineNum, snippet, score: 1 });
            }
          }
        } catch { /* skip */ }
      }
      // Re-score by match frequency per file
      for (const r of results) {
        r.score = fileScores.get(r.file) ?? 1;
      }
      results.sort((a, b) => b.score - a.score);
      return results.slice(0, topK);
    } catch { /* fall through to Node walk */ }
  }

  // Node.js fallback: walk and match
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  for (const filePath of walkDir(rootPath)) {
    if (results.length >= topK * 3) break;
    const ext = extname(filePath).replace(".", "");
    if (!CODE_EXTS.has(ext)) continue;
    try {
      const stat = statSync(filePath);
      if (stat.size > 256 * 1024) continue;
      const text = readFileSync(filePath, "utf-8");
      const lines = text.split("\n");
      let fileScore = 0;
      for (let i = 0; i < lines.length; i++) {
        const lower = lines[i].toLowerCase();
        const matches = terms.filter((t) => lower.includes(t)).length;
        if (matches > 0) {
          fileScore += matches;
          results.push({ file: relative(rootPath, filePath), line: i + 1, snippet: lines[i].trimEnd(), score: matches });
        }
      }
    } catch { /* skip */ }
  }
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, topK);
}

// ─── Type aliases ──────────────────────────────────────────────────────────

type CanonicalSourceType = "github" | "web" | "playwright" | "pdf" | "local" | "slack" | "discord" | "video" | "notion" | "confluence" | "arxiv" | "sitemap" | "dataset" | "text" | "api_spec";

// ─── Tools ─────────────────────────────────────────────────────────────────

// 1. CONTEXT — retrieve + auto-store in one call
server.tool(
  "context",
  "Call this at the start of every task. Retrieves memories from past sessions, indexed source knowledge, and local codebase matches — all at once. " +
  "Optionally pass `messages` and `events` and important session context will be ingested in the background so the next session automatically continues where this one left off. " +
  "This is how memory accumulates across coding sessions without any manual effort.",
  {
    query: z.string().describe("What you are trying to answer or accomplish"),
    session_id: z.string().optional().describe("Current session ID — used to scope retrieval and to store messages if provided"),
    agent_id: z.string().optional().describe("Stable agent identity for agent-scoped memory"),
    task_id: z.string().optional().describe("External task or work-item identifier for task-scoped memory"),
    messages: z.array(z.object({ role: z.string(), content: z.string() })).optional().describe(
      "The conversation so far. If provided, these are ingested in the background so memories carry into the next session automatically."
    ),
    events: z.array(z.object({
      kind: z.enum(["decision", "constraint", "outcome", "failure", "task_update", "file_edit", "tool_result"]),
      summary: z.string(),
      details: z.string().optional(),
      salience: z.enum(["low", "medium", "high"]).optional(),
      timestamp: z.string().optional(),
      filePaths: z.array(z.string()).optional(),
      toolName: z.string().optional(),
      success: z.boolean().optional(),
    })).optional().describe("Structured work events to promote as durable session-state memory."),
    promotion_mode: z.enum(["session_state_v1", "user_specific_legacy"]).optional().describe("Override the project default promotion behavior."),
    top_k: z.number().optional().default(10),
  },
  async ({ query, session_id, agent_id, task_id, messages, events, promotion_mode, top_k }) => {
    try {
      const userId = defaultUserId();
      const project = await resolveProject();
      const sid = session_id?.trim();

      // Background-ingest messages for future sessions (fire-and-forget — never blocks retrieval)
      if (messages && messages.length > 0 && sid) {
        const toIngest = messages
          .filter((m) => m.role !== "system")
          .map((m) => ({ role: m.role, content: m.content, timestamp: new Date().toISOString() }));
        if (toIngest.length > 0 || (events && events.length > 0)) {
          client.ingestSession({
            project,
            session_id: sid,
            user_id: userId,
            agent_id,
            task_id,
            messages: toIngest,
            events,
            promotion_mode,
          }).catch(() => {});
        }
      }

      const localResults = searchLocalFiles(query, process.cwd(), top_k ?? 10);

      let remoteContext = "";
      let remoteResults: unknown[] = [];
      let memories: unknown[] = [];
      try {
        const response = await client.query({
          project,
          query,
          top_k,
          include_memories: true,
          include_pending: true,
          user_id: userId,
          session_id: sid,
          agent_id,
        });
        remoteContext = response.context || "";
        remoteResults = response.results || [];
        memories = (response as any).memories || [];
      } catch { /* network issue — local results still returned */ }

      if (task_id || agent_id) {
        try {
          const scoped = await client.searchMemories({
            project,
            query,
            user_id: userId,
            session_id: sid,
            agent_id,
            task_id,
            top_k: Math.min(top_k ?? 10, 8),
            include_pending: true,
            profile: "balanced",
          });
          const scopedMemories = ((scoped as any).results || []).map((item: any) => item.memory || item.chunk || item);
          memories = [...memories, ...scopedMemories];
        } catch { /* best effort */ }
      }

      return ok({
        tool: "context",
        query,
        context: remoteContext,
        local_results: localResults,
        remote_results: remoteResults,
        memories,
        count: localResults.length + remoteResults.length + memories.length,
      });
    } catch (error: any) {
      return err(error.message);
    }
  }
);

// 2. REMEMBER — store an explicit fact or preference
server.tool(
  "remember",
  "Store a single durable memory or promote important session context. Use this proactively for facts, preferences, project decisions, constraints, workflow notes, and other context worth keeping. " +
  "Do NOT use for raw conversation history — pass `messages` and optional `events` to `context` or `remember` and memory extraction will do the promotion.",
  {
    content: z.union([
      z.string().describe("A durable fact, preference, decision, constraint, workflow note, or other context to remember"),
      z.array(z.object({ role: z.string(), content: z.string() })).describe("Conversation turns — important session context is extracted automatically"),
    ]),
    memory_type: z.enum(["factual", "preference", "event", "relationship", "opinion", "goal", "instruction", "decision", "constraint", "solution", "project_state", "correction", "workflow"]).optional().default("factual"),
    session_id: z.string().optional().describe("Session ID — required when passing a message array"),
    agent_id: z.string().optional().describe("Stable agent identity for agent-scoped memory"),
    task_id: z.string().optional().describe("External task or work-item identifier for task-scoped memory"),
    events: z.array(z.object({
      kind: z.enum(["decision", "constraint", "outcome", "failure", "task_update", "file_edit", "tool_result"]),
      summary: z.string(),
      details: z.string().optional(),
      salience: z.enum(["low", "medium", "high"]).optional(),
      timestamp: z.string().optional(),
      filePaths: z.array(z.string()).optional(),
      toolName: z.string().optional(),
      success: z.boolean().optional(),
    })).optional().describe("Optional structured work events to ingest alongside conversation turns."),
    promotion_mode: z.enum(["session_state_v1", "user_specific_legacy"]).optional().describe("Override the project default promotion behavior."),
  },
  async ({ content, memory_type, session_id, agent_id, task_id, events, promotion_mode }) => {
    try {
      const project = await resolveProject();
      const userId = defaultUserId();
      const sid = session_id?.trim();

      if (typeof content === "string") {
        const result = await client.addMemory({
          project,
          content,
          memory_type,
          user_id: userId,
          session_id: sid,
          agent_id,
          task_id,
          promotion_mode,
        });
        return ok({
          tool: "remember",
          stored: result.success === true,
          id: (result as any)?.memory_id || (result as any)?.id || null,
          memory_type,
        });
      } else {
        if (!sid) return err("session_id is required when passing a message array.");
        const messages = content
          .filter((m) => m.role !== "system")
          .map((m) => ({ role: m.role, content: m.content, timestamp: new Date().toISOString() }));
        const result = await client.ingestSession({
          project,
          session_id: sid,
          user_id: userId,
          agent_id,
          task_id,
          messages,
          events,
          promotion_mode,
        });
        return ok({
          tool: "remember",
          stored: true,
          mode: "conversation_extraction",
          memories_created: (result as any)?.memories_created || null,
          session_id: sid,
        });
      }
    } catch (error: any) {
      return err(error.message);
    }
  }
);

// 3. FORGET — delete a memory by ID
server.tool(
  "forget",
  "Delete a memory by its ID. Use when a stored fact is wrong or the user asks to forget something. Memory IDs come from `context` or `search` results.",
  {
    memory_id: z.string().describe("ID of the memory to delete"),
  },
  async ({ memory_id }) => {
    try {
      const result = await client.deleteMemory(memory_id);
      return ok({ tool: "forget", deleted: result.success === true || (result as any)?.deleted === memory_id, memory_id });
    } catch (error: any) {
      return err(error.message);
    }
  }
);

// 4. COMPRESS — delta compress a long conversation
server.tool(
  "compress",
  "Compress a long conversation by storing old messages as memories and returning a trimmed array. Use when the context window is filling up — past context is retrievable via `context` on demand.",
  {
    messages: z.array(z.object({ role: z.string(), content: z.string() })).describe("Full message array to compress"),
    keep_last: z.number().optional().default(6).describe("How many recent messages to keep verbatim"),
    session_id: z.string().describe("Session ID — used to scope stored memories"),
    agent_id: z.string().optional().describe("Stable agent identity for agent-scoped memory"),
    task_id: z.string().optional().describe("External task or work-item identifier for task-scoped memory"),
    events: z.array(z.object({
      kind: z.enum(["decision", "constraint", "outcome", "failure", "task_update", "file_edit", "tool_result"]),
      summary: z.string(),
      details: z.string().optional(),
      salience: z.enum(["low", "medium", "high"]).optional(),
      timestamp: z.string().optional(),
      filePaths: z.array(z.string()).optional(),
      toolName: z.string().optional(),
      success: z.boolean().optional(),
    })).optional().describe("Structured work events to ingest alongside compressed conversation history."),
    promotion_mode: z.enum(["session_state_v1", "user_specific_legacy"]).optional().describe("Override the project default promotion behavior."),
  },
  async ({ messages, keep_last, session_id, agent_id, task_id, events, promotion_mode }) => {
    try {
      const project = await resolveProject();
      const userId = defaultUserId();
      const sid = session_id.trim();

      const keepN = Math.max(1, keep_last ?? 6);
      const toCompress = messages.slice(0, Math.max(0, messages.length - keepN));
      const kept = messages.slice(Math.max(0, messages.length - keepN));

      if (toCompress.length === 0) {
        return ok({ tool: "compress", compressed: false, messages, messages_kept: messages.length, messages_compressed: 0 });
      }

      const ingestMessages = toCompress
        .filter((m) => m.role !== "system")
        .map((m) => ({ role: m.role, content: m.content, timestamp: new Date().toISOString() }));

      if (ingestMessages.length > 0) {
        await client.ingestSession({
          project,
          session_id: `${sid}-compressed`,
          user_id: userId,
          agent_id,
          task_id,
          messages: ingestMessages,
          events,
          promotion_mode,
        });
      }

      return ok({
        tool: "compress",
        compressed: true,
        messages: kept,
        messages_kept: kept.length,
        messages_compressed: toCompress.length,
        note: "Compressed messages stored in memory. Use `context` to retrieve relevant context on demand.",
      });
    } catch (error: any) {
      return err(error.message);
    }
  }
);

// 5. INDEX — connect a source for knowledge retrieval
server.tool(
  "index",
  "Connect a source so it can be retrieved via `search` and `context`. Supports: github, web, playwright, pdf, local, slack, discord, video, notion, confluence, arxiv, sitemap, dataset, text, api_spec.",
  {
    type: z.enum(["github", "web", "pdf", "local", "slack", "discord", "video", "notion", "confluence", "arxiv", "sitemap", "dataset", "text", "api_spec"]).describe("Source type. Use 'web' for any URL or website (includes crawling, sitemaps, docs sites)."),
    name: z.string().optional().describe("Human-readable name for the source"),
    url: z.string().optional().describe("URL for web/pdf/video/sitemap/arxiv/api_spec sources"),
    owner: z.string().optional().describe("GitHub repo owner"),
    repo: z.string().optional().describe("GitHub repo name"),
    branch: z.string().optional().describe("GitHub branch"),
    path: z.string().optional().describe("Local filesystem path"),
    glob: z.string().optional().describe("Glob pattern for local sources"),
    max_files: z.number().optional().describe("Max files to ingest"),
    max_pages: z.number().optional().describe("Max pages to ingest (web/sitemap)"),
    channel_ids: z.array(z.string()).optional().describe("Slack/Discord channel IDs"),
    guild_id: z.string().optional().describe("Discord guild/server ID"),
    token: z.string().optional().describe("Auth token for private sources (Slack bot token, GitHub PAT, Notion token, Confluence API token)"),
    email: z.string().optional().describe("Email for Confluence authentication"),
    space_key: z.string().optional().describe("Confluence space key"),
    days_back: z.number().optional().describe("How many days back to fetch (Slack/Discord)"),
    platform: z.enum(["youtube", "loom", "generic"]).optional().describe("Video platform"),
    content: z.string().optional().describe("Inline content (for text/api_spec sources)"),
    title: z.string().optional().describe("Title (for text sources)"),
  },
  async (input) => {
    try {
      const project = await resolveProject();

      const result = await client.createCanonicalSource(project, {
        type: input.type as any,
        name: input.name,
        auto_index: true,
        owner: input.owner,
        repo: input.repo,
        branch: input.branch,
        url: input.url,
        path: input.path,
        file_path: input.path,
        glob: input.glob,
        max_files: input.max_files,
        max_pages: input.max_pages,
        channel_ids: input.channel_ids,
        guild_id: input.guild_id,
        token: input.token,
        email: input.email,
        space_key: input.space_key,
        days_back: input.days_back,
        platform: input.platform,
        content: input.content,
        title: input.title,
      } as any);
      return ok({
        tool: "index",
        source_id: (result as any).source_id || (result as any).id || null,
        type: input.type,
        project,
        status: (result as any).status || "indexing",
        note: "Indexing started. Call `list_sources` to check status — search works once status shows SYNCED. Small sources: ~1 min. Large repos/Slack/PDFs: 5–20 min.",
      });
    } catch (error: any) {
      return err(error.message);
    }
  }
);

// 9. LIST_SOURCES — list all indexed sources
server.tool(
  "list_sources",
  "List all indexed sources in the current project. Use this to see what knowledge bases are connected and their sync status.",
  {
    project: z.string().optional().describe("Project slug (defaults to current project)"),
  },
  async ({ project: explicitProject }) => {
    try {
      const project = await resolveProject(explicitProject);
      const result = await client.listSources(project);
      return ok({
        tool: "list_sources",
        project,
        sources: (result as any).sources || result || [],
        count: ((result as any).sources || result || []).length,
      });
    } catch (error: any) {
      return err(error.message);
    }
  }
);

// 10. LIST_MEMORIES — list stored memories for the current user
server.tool(
  "list_memories",
  "List stored memories for the current user. Use this to review what has been remembered, or before calling `forget` to find the right memory ID.",
  {
    limit: z.number().optional().default(20).describe("Max memories to return"),
    query: z.string().optional().describe("Optional filter query — returns only memories relevant to this topic"),
    agent_id: z.string().optional().describe("Stable agent identity for agent-scoped memory"),
    task_id: z.string().optional().describe("External task or work-item identifier for task-scoped memory"),
  },
  async ({ limit, query, agent_id, task_id }) => {
    try {
      const project = await resolveProject();
      const userId = defaultUserId();
      let memories: unknown[];
      if (query?.trim()) {
        const resp = await client.searchMemories({ project, user_id: userId, agent_id, task_id, query, top_k: limit ?? 20 });
        memories = (resp as any).results || (resp as any).memories || [];
      } else {
        const resp = await client.getUserProfile({ project, user_id: userId });
        memories = (resp as any).memories || [];
      }
      return ok({
        tool: "list_memories",
        user_id: userId,
        memories: (memories as any[]).slice(0, limit ?? 20),
        count: (memories as any[]).length,
      });
    } catch (error: any) {
      return err(error.message);
    }
  }
);

// 11. LIST_PROJECTS — list available projects
server.tool(
  "list_projects",
  "List all available RetainDB projects. Use this to find the right project slug when working with multiple projects.",
  {},
  async () => {
    try {
      const result = await client.listProjects();
      return ok({
        tool: "list_projects",
        projects: result.projects || [],
        count: (result.projects || []).length,
      });
    } catch (error: any) {
      return err(error.message);
    }
  }
);

// 6. SEARCH — semantic search over indexed sources + local codebase
server.tool(
  "search",
  "Search both indexed project sources (GitHub, docs, PDFs) and the local codebase. Use this to find relevant code, documentation, or context.",
  {
    query: z.string().describe("What to search for"),
    top_k: z.number().optional().default(10),
    session_id: z.string().optional(),
  },
  async ({ query, top_k, session_id }) => {
    try {
      const project = await resolveProject();
      const localResults = searchLocalFiles(query, process.cwd(), top_k ?? 10);

      let remoteContext = "";
      let remoteResults: unknown[] = [];
      try {
        const response = await client.query({
          project,
          query,
          top_k,
          include_memories: false,
          user_id: defaultUserId(),
          session_id: session_id?.trim(),
        });
        remoteContext = response.context || "";
        remoteResults = response.results || [];
      } catch { /* return local results if API fails */ }

      return { content: [{ type: "text" as const, text: JSON.stringify(buildMcpSearchPayload({
        mode: "semantic",
        query,
        context: remoteContext,
        results: remoteResults,
        ...(localResults.length > 0 ? { local_results: localResults } : {}),
      } as any), null, 2) }] };
    } catch (error: any) {
      return err(error.message);
    }
  }
);

// 7. GREP — regex/text search local files
server.tool(
  "grep",
  "Regex or text search across a local codebase. Use this when you know the symbol, string, or pattern you want.",
  {
    query: z.string().describe("Text or regex pattern to search for"),
    path: z.string().optional().describe("Search root. Defaults to current working directory."),
    file_types: z.array(z.string()).optional().describe("Limit to these extensions e.g. ['ts', 'js']"),
    max_results: z.number().optional().default(20),
    case_sensitive: z.boolean().optional().default(false),
  },
  async ({ query, path, file_types, max_results, case_sensitive }) => {
    const rootPath = path || process.cwd();
    const results: Array<{ file: string; matches: Array<{ line: number; content: string }> }> = [];
    const regex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), case_sensitive ? "g" : "gi");

    for (const filePath of walkDir(rootPath, file_types)) {
      if (results.length >= (max_results ?? 20)) break;
      try {
        const stat = statSync(filePath);
        if (stat.size > 512 * 1024) continue;
        const text = readFileSync(filePath, "utf-8");
        const lines = text.split("\n");
        const matches: Array<{ line: number; content: string }> = [];
        lines.forEach((line, index) => {
          regex.lastIndex = 0;
          if (regex.test(line)) {
            matches.push({ line: index + 1, content: line.trimEnd() });
          }
        });
        if (matches.length > 0) {
          results.push({ file: relative(rootPath, filePath), matches: matches.slice(0, 10) });
        }
      } catch { /* skip unreadable files */ }
    }

    return ok({
      tool: "grep",
      query,
      path: rootPath,
      results,
      count: results.length,
    });
  }
);

// 8. READ — read a local file with optional line range
server.tool(
  "read",
  "Read a local file with optional line ranges. Use this after `grep` when you want the actual source.",
  {
    path: z.string().describe("Absolute or relative path to the file"),
    start_line: z.number().optional().default(1),
    end_line: z.number().optional().default(200),
  },
  async ({ path, start_line, end_line }) => {
    try {
      const fullPath = path.includes(":") || path.startsWith("/") ? path : join(process.cwd(), path);
      const stats = statSync(fullPath);
      if (!stats.isFile()) {
        return err(`${path} is not a file.`);
      }
      return ok({
        tool: "read",
        path: fullPath,
        start_line,
        end_line,
        content: readFileWindow(fullPath, start_line, end_line),
      });
    } catch (error: any) {
      return err(error.message);
    }
  }
);

// ─── Entry point ───────────────────────────────────────────────────────────

async function startupProbe() {
  try {
    const project = await resolveProject();
    const userId = defaultUserId();
    console.error(`[retaindb-mcp] ready — project: ${project}, user: ${userId}`);
  } catch (e: any) {
    console.error(`[retaindb-mcp] warning: could not resolve project (${e?.message ?? e})`);
  }
}

async function main() {
  if (!API_KEY) {
    console.error("Error: RETAINDB_API_KEY is required");
    process.exit(1);
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[retaindb-mcp] running on stdio");
  startupProbe().catch(() => {});
}

if (process.argv[1] && /server\.(mjs|cjs|js|ts)$/.test(process.argv[1])) {
  main().catch(console.error);
}
