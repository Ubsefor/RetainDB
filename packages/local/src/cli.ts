#!/usr/bin/env node
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { randomUUID, createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

type Message = { role: string; content: string; timestamp?: string };
type WorkEvent = {
  kind: string;
  summary: string;
  details?: string;
  salience?: "low" | "medium" | "high";
  timestamp?: string;
  filePaths?: string[];
  toolName?: string;
  success?: boolean;
};

type Memory = {
  id: string;
  project: string;
  content: string;
  memory_type: string;
  user_id?: string;
  session_id?: string;
  agent_id?: string;
  task_id?: string;
  importance: number;
  confidence: number;
  metadata: Record<string, unknown>;
  embedding?: number[];
  created_at: string;
  updated_at: string;
  active: boolean;
};

type Project = { id: string; name: string; slug: string; created_at: string };
type Share = {
  id: string;
  project: string;
  session_id: string;
  title: string;
  memory_ids: string[];
  created_at: string;
  expires_at?: string;
};
type ContextSnapshot = {
  hash: string;
  project: string;
  query: string;
  entries: Array<{ kind: string; id: string; hash: string; title: string; content: string }>;
  created_at: string;
};
type StoreData = { projects: Project[]; memories: Memory[]; shares: Share[]; contextSnapshots: ContextSnapshot[] };

const STOP_WORDS = new Set(["the", "and", "for", "that", "with", "this", "from", "into", "user", "agent", "session", "tool", "used", "uses", "using"]);
const RRF_K = 60;
const LOW_SIGNAL_PATTERNS = [
  /^\s*(ok|okay|thanks|thank you|done|yes|no|hi|hello)\s*[.!?]*\s*$/i,
  /^(read|list|open|show)\s+file$/i,
  /^session_(start|end|idle) captured$/i,
];

const DEFAULT_PORT = Number(process.env.RETAINDB_PORT || process.env.PORT || 3111);
const DEFAULT_PROJECT = process.env.RETAINDB_PROJECT || "default";
const RETAINDB_HOME = resolve(process.env.RETAINDB_HOME || join(homedir(), ".retaindb"));
const STORE_PATH = resolve(process.env.RETAINDB_STORE || join(RETAINDB_HOME, "local-store.json"));
const JOURNAL_PATH = `${STORE_PATH}.journal.jsonl`;
const BENCHMARK_DIR = join(RETAINDB_HOME, "benchmarks");
const EMBEDDING_PROVIDER = process.env.RETAINDB_EMBEDDING_PROVIDER || "hash";
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", ".next", "coverage", ".turbo", ".cache", ".vercel", ".wrangler"]);
const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".rs", ".go", ".java", ".cs", ".rb", ".php", ".md", ".mdx", ".json", ".toml", ".yaml", ".yml", ".css", ".scss", ".html", ".sql"]);
let transformerPipeline: Promise<any> | null = null;

function now() {
  return new Date().toISOString();
}

function slugify(value: string) {
  const slug = value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return slug || "default";
}

function tokenize(text: string) {
  return text.toLowerCase().match(/[a-z0-9_./-]{2,}/g) || [];
}

function uniqueTokens(text: string) {
  return Array.from(new Set(tokenize(text)));
}

function hashString(text: string) {
  return createHash("sha256").update(text).digest("hex");
}

function estimateTokens(text: string) {
  return Math.ceil(text.length / 4);
}

function truncateTokens(text: string, tokenBudget: number) {
  const maxChars = Math.max(0, tokenBudget * 4);
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars).replace(/\s+\S*$/, "")}\n[trimmed to ${tokenBudget} token budget]`;
}

function concepts(text: string, limit = 10) {
  return uniqueTokens(text)
    .filter((token) => token.length > 2 && !STOP_WORDS.has(token))
    .slice(0, limit);
}

function clamp(value: number, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

function signalQuality(text: string) {
  const trimmed = text.trim();
  const normalized = trimmed.replace(/^(prompt|message|event|session_start|session_end|tool_result|post_tool_use|pre_tool_use)\s*:\s*/i, "").trim();
  if (!trimmed) return 0;
  if (LOW_SIGNAL_PATTERNS.some((pattern) => pattern.test(normalized || trimmed))) return 0.05;
  const tokens = uniqueTokens(normalized || trimmed);
  const hasCodePath = /\b[\w.-]+\/[\w./-]+\b|\b[\w.-]+\.(ts|tsx|js|jsx|py|rs|go|md|json|toml|yaml|yml)\b/i.test(normalized || trimmed);
  const hasDecision = /\b(decided|prefer|use|avoid|because|constraint|fixed|root cause|regression|todo|next|deploy|test|auth|rate limit|schema|migration)\b/i.test(normalized || trimmed);
  const hasOutcome = /\b(pass|passed|fail|failed|error|resolved|implemented|created|updated|removed|blocked)\b/i.test(normalized || trimmed);
  return clamp(0.18 + Math.min(tokens.length, 80) / 120 + (hasCodePath ? 0.2 : 0) + (hasDecision ? 0.25 : 0) + (hasOutcome ? 0.18 : 0));
}

function inferMemoryType(content: string, fallback = "factual") {
  if (/\b(decided|prefer|constraint|avoid|because|should|must)\b/i.test(content)) return "semantic";
  if (/\b(command|workflow|steps?|run|deploy|release|test|build|install)\b/i.test(content)) return "procedural";
  if (/\b(error|failed|fix|fixed|root cause|regression|bug)\b/i.test(content)) return "correction";
  if (/\bsummary|handoff|session ended\b/i.test(content)) return "session_summary";
  return fallback;
}

function durableContent(content: string, type: string) {
  const lines = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (type === "semantic" || type === "procedural" || type === "correction") {
    const useful = lines.filter((line) => signalQuality(line) >= 0.35).slice(0, 10);
    return useful.length ? useful.join("\n") : lines.slice(0, 6).join("\n");
  }
  return lines.slice(0, 12).join("\n");
}

function hashEmbedding(text: string, dims = 96) {
  const vector = Array.from({ length: dims }, () => 0);
  for (const token of tokenize(text)) {
    const hash = createHash("sha256").update(token).digest();
    const index = hash[0] % dims;
    const sign = hash[1] % 2 === 0 ? 1 : -1;
    vector[index] += sign * (1 + Math.min(token.length, 12) / 12);
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => Number((value / norm).toFixed(6)));
}

async function transformerEmbedding(text: string) {
  if (!transformerPipeline) {
    transformerPipeline = (async () => {
      const dynamicImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<any>;
      const transformers = await dynamicImport("@xenova/transformers");
      return transformers.pipeline("feature-extraction", process.env.RETAINDB_EMBEDDING_MODEL || "Xenova/all-MiniLM-L6-v2");
    })();
  }
  const extractor = await transformerPipeline;
  const output = await extractor(text.slice(0, 8000), { pooling: "mean", normalize: true });
  const raw = Array.from(output.data || output.tolist?.()?.[0] || []) as number[];
  return raw.map((value) => Number(value.toFixed(6)));
}

async function embedText(text: string) {
  if (EMBEDDING_PROVIDER === "local-transformers" || EMBEDDING_PROVIDER === "transformers") {
    try {
      return await transformerEmbedding(text);
    } catch {
      return hashEmbedding(text);
    }
  }
  return hashEmbedding(text);
}

function cosine(a: number[], b: number[]) {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < len; i++) dot += a[i] * b[i];
  return dot;
}

function redactSecrets(text: string) {
  return text
    .replace(/\b(sk-[A-Za-z0-9_-]{20,})\b/g, "[REDACTED_OPENAI_KEY]")
    .replace(/\b(cf[a-z]_[A-Za-z0-9_-]{20,})\b/g, "[REDACTED_CLOUDFLARE_TOKEN]")
    .replace(/\b(xox[baprs]-[A-Za-z0-9-]{10,})\b/g, "[REDACTED_SLACK_TOKEN]")
    .replace(/\b(gh[pousr]_[A-Za-z0-9_]{20,})\b/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/(["']?(?:api[_-]?key|token|secret|password)["']?\s*[:=]\s*["']?)[^"',\s}]+/gi, "$1[REDACTED]");
}

function redactUnknown<T>(value: T): T {
  if (typeof value === "string") return redactSecrets(value) as T;
  if (Array.isArray(value)) return value.map((item) => redactUnknown(item)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = /api[_-]?key|token|secret|password/i.test(key) ? "[REDACTED]" : redactUnknown(entry);
    }
    return out as T;
  }
  return value;
}

function loadStore(): StoreData {
  mkdirSync(RETAINDB_HOME, { recursive: true });
  if (!existsSync(STORE_PATH)) {
    const created = now();
    return {
      projects: [{ id: "proj_default", name: "default", slug: "default", created_at: created }],
      memories: [],
      shares: [],
      contextSnapshots: [],
    };
  }
  const parsed = JSON.parse(readFileSync(STORE_PATH, "utf8")) as Partial<StoreData>;
  return {
    projects: Array.isArray(parsed.projects) ? parsed.projects : [],
    memories: Array.isArray(parsed.memories) ? parsed.memories : [],
    shares: Array.isArray(parsed.shares) ? parsed.shares : [],
    contextSnapshots: Array.isArray(parsed.contextSnapshots) ? parsed.contextSnapshots : [],
  };
}

function saveStore(data: StoreData) {
  mkdirSync(RETAINDB_HOME, { recursive: true });
  const temp = `${STORE_PATH}.tmp`;
  writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  renameSync(temp, STORE_PATH);
}

function appendJournal(event: string, payload: Record<string, unknown>) {
  mkdirSync(RETAINDB_HOME, { recursive: true });
  appendFileSync(JOURNAL_PATH, `${JSON.stringify({ event, at: now(), ...payload })}\n`, "utf8");
}

function writeBenchmarkReport(report: Record<string, unknown>) {
  mkdirSync(BENCHMARK_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(BENCHMARK_DIR, `local-${stamp}.json`);
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return path;
}

function isTextCodeFile(path: string) {
  return CODE_EXTENSIONS.has(path.slice(path.lastIndexOf(".")).toLowerCase());
}

function listCodeFiles(root: string, limit = 400): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    if (out.length >= limit) return;
    let entries: any[] = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= limit) break;
      if (entry.name.startsWith(".") && entry.name !== ".env.example") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full);
      } else if (entry.isFile() && isTextCodeFile(entry.name)) {
        try {
          if (statSync(full).size <= 240_000) out.push(full);
        } catch {}
      }
    }
  };
  walk(resolve(root));
  return out;
}

function extractSymbols(text: string) {
  const symbols: string[] = [];
  const patterns = [
    /^\s*export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)/gm,
    /^\s*(?:async\s+)?function\s+([A-Za-z0-9_$]+)/gm,
    /^\s*(?:export\s+)?class\s+([A-Za-z0-9_$]+)/gm,
    /^\s*(?:export\s+)?const\s+([A-Za-z0-9_$]+)\s*=/gm,
    /^\s*(?:def|class)\s+([A-Za-z0-9_]+)/gm,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) symbols.push(match[1]);
  }
  return Array.from(new Set(symbols)).slice(0, 30);
}

function codeMap(root: string, query = "", limit = 80) {
  const q = new Set(uniqueTokens(query));
  return listCodeFiles(root)
    .map((file) => {
      const rel = file.replace(resolve(root), "").replace(/^[/\\]/, "");
      let text = "";
      try {
        text = readFileSync(file, "utf8");
      } catch {}
      const symbols = extractSymbols(text);
      const haystack = `${rel} ${symbols.join(" ")}`.toLowerCase();
      const score = [...q].reduce((sum, token) => sum + (haystack.includes(token) ? 1 : 0), 0);
      return { file: rel, symbols, score, lines: text.split(/\r?\n/).length, hash: hashString(text).slice(0, 16) };
    })
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))
    .slice(0, limit);
}

function packFileChunks(root: string, files: string[], query: string, tokenBudget: number) {
  const qTokens = uniqueTokens(query).filter((token) => !STOP_WORDS.has(token));
  const chunks: Array<{ file: string; content: string; hash: string; tokens: number }> = [];
  for (const input of files.slice(0, 24)) {
    const full = resolve(root, input);
    if (!full.startsWith(resolve(root)) || !existsSync(full)) continue;
    let text = "";
    try {
      if (statSync(full).size > 240_000) continue;
      text = readFileSync(full, "utf8");
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    const selected = new Set<number>();
    lines.forEach((line, index) => {
      const lower = line.toLowerCase();
      if (/^\s*(export\s+)?(async\s+)?(function|class|const|interface|type)\s+|^\s*(def|class)\s+/i.test(line)) selected.add(index);
      if (qTokens.some((token) => lower.includes(token))) {
        for (let i = Math.max(0, index - 3); i <= Math.min(lines.length - 1, index + 5); i++) selected.add(i);
      }
    });
    const picked = [...selected].sort((a, b) => a - b).slice(0, 140);
    const body = picked.length
      ? picked.map((line) => `${line + 1}: ${lines[line]}`).join("\n")
      : lines.slice(0, 80).map((line, index) => `${index + 1}: ${line}`).join("\n");
    const rel = full.replace(resolve(root), "").replace(/^[/\\]/, "");
    const content = `File: ${rel}\n${truncateTokens(body, Math.max(80, Math.floor(tokenBudget / Math.max(files.length, 1))))}`;
    chunks.push({ file: rel, content, hash: hashString(text), tokens: estimateTokens(content) });
  }
  return chunks;
}

function compressToolOutput(output: string, tokenBudget = 500) {
  const lines = redactSecrets(String(output || "")).split(/\r?\n/);
  const keep = lines.filter((line) =>
    /\b(error|failed|failure|exception|traceback|expected|received|assert|timeout|cannot|denied|not found|stack|at\s+[\w.]+|tests? failed)\b/i.test(line) ||
    /^\s*(FAIL|ERROR|✘|×|Caused by:)/i.test(line)
  );
  const summary = [
    `Original output: ${lines.length} lines, approx ${estimateTokens(output)} tokens.`,
    keep.length ? "Important lines:" : "No obvious errors found. Keeping tail.",
    ...(keep.length ? keep.slice(0, 80) : lines.slice(-40)),
  ].join("\n");
  return truncateTokens(summary, tokenBudget);
}

class LocalMemoryRuntime {
  private data: StoreData;

  constructor() {
    this.data = loadStore();
    this.ensureProject(DEFAULT_PROJECT);
    this.persist();
  }

  persist() {
    saveStore(this.data);
  }

  ensureProject(nameOrSlug: string): Project {
    const slug = slugify(nameOrSlug);
    const existing = this.data.projects.find((project) => project.slug === slug || project.name === nameOrSlug);
    if (existing) return existing;
    const project = { id: `proj_${randomUUID()}`, name: nameOrSlug, slug, created_at: now() };
    this.data.projects.push(project);
    this.persist();
    return project;
  }

  listProjects() {
    return this.data.projects;
  }

  async addMemory(input: {
    project?: string;
    content: string;
    memory_type?: string;
    user_id?: string;
    session_id?: string;
    agent_id?: string;
    task_id?: string;
    importance?: number;
    confidence?: number;
    metadata?: Record<string, unknown>;
  }) {
    const project = this.ensureProject(input.project || DEFAULT_PROJECT).slug;
    const rawText = redactSecrets(input.content).trim();
    const inferredType = inferMemoryType(rawText, input.memory_type || "factual");
    const text = durableContent(rawText, inferredType);
    const quality = signalQuality(text);
    if (quality < 0.12) {
      const timestamp = now();
      return {
        id: `skip_${createHash("sha1").update(`${project}:${timestamp}:${rawText}`).digest("hex").slice(0, 12)}`,
        project,
        content: text || rawText,
        memory_type: "skipped",
        user_id: input.user_id,
        session_id: input.session_id,
        agent_id: input.agent_id,
        task_id: input.task_id,
        importance: 0,
        confidence: 0,
        metadata: { skipped: true, reason: "low_signal", quality },
        created_at: timestamp,
        updated_at: timestamp,
        active: false,
      } satisfies Memory;
    }
    const existingHash = createHash("sha256")
      .update(`${project}\n${input.session_id || ""}\n${input.agent_id || ""}\n${text.toLowerCase()}`)
      .digest("hex");
    const duplicate = this.data.memories.find((memory) => memory.metadata?.hash === existingHash && memory.active);
    if (duplicate) return duplicate;
    const timestamp = now();
    const memory: Memory = {
      id: `mem_${randomUUID()}`,
      project,
      content: text,
      memory_type: inferredType,
      user_id: input.user_id,
      session_id: input.session_id,
      agent_id: input.agent_id,
      task_id: input.task_id,
      importance: clamp((input.importance ?? 0.62) + quality * 0.28 + (inferredType === "semantic" ? 0.08 : inferredType === "procedural" ? 0.06 : 0), 0.1, 0.99),
      confidence: clamp((input.confidence ?? 0.78) + quality * 0.16, 0.1, 0.98),
      metadata: {
        ...redactUnknown(input.metadata || {}),
        concepts: concepts(text),
        hash: existingHash,
        quality,
        strength: clamp(quality + (input.importance ?? 0.6) / 2),
        access_count: 0,
        last_accessed_at: undefined,
        original_type: input.memory_type,
      },
      embedding: await embedText(text),
      created_at: timestamp,
      updated_at: timestamp,
      active: true,
    };
    this.data.memories.push(memory);
    this.persist();
    appendJournal("memory.added", { id: memory.id, project, session_id: memory.session_id, memory_type: memory.memory_type });
    return memory;
  }

  async ingestSession(input: {
    project?: string;
    session_id: string;
    user_id?: string;
    agent_id?: string;
    task_id?: string;
    messages?: Message[];
    events?: WorkEvent[];
  }) {
    const memories: Memory[] = [];
    const project = input.project || DEFAULT_PROJECT;
    for (const event of input.events || []) {
      const content = [
        `${event.kind}: ${event.summary}`,
        event.details ? `Details: ${event.details}` : "",
        event.filePaths?.length ? `Files: ${event.filePaths.join(", ")}` : "",
        event.toolName ? `Tool: ${event.toolName}` : "",
      ].filter(Boolean).join("\n");
      memories.push(await this.addMemory({
        project,
        content,
        memory_type: event.kind === "failure" ? "correction" : event.kind,
        user_id: input.user_id,
        session_id: input.session_id,
        agent_id: input.agent_id,
        task_id: input.task_id,
        importance: event.salience === "high" ? 0.95 : event.salience === "low" ? 0.45 : 0.7,
        metadata: { source: "agent_event", event },
      }));
    }
    for (const message of input.messages || []) {
      if (message.role === "system" || !message.content?.trim()) continue;
      const prefix = message.role === "user" ? "User asked" : message.role === "assistant" ? "Agent responded" : message.role;
      memories.push(await this.addMemory({
        project,
        content: `${prefix}: ${message.content.trim()}`,
        memory_type: message.role === "user" ? "event" : "project_state",
        user_id: input.user_id,
        session_id: input.session_id,
        agent_id: input.agent_id,
        task_id: input.task_id,
        importance: message.role === "user" ? 0.75 : 0.55,
        metadata: { source: "session_message", role: message.role, timestamp: message.timestamp },
      }));
    }
    const stored = memories.filter((memory) => memory.active);
    return { memories_created: stored.length, memories: stored, skipped: memories.length - stored.length };
  }

  async search(input: {
    project?: string;
    query: string;
    user_id?: string;
    session_id?: string;
    agent_id?: string;
    task_id?: string;
    top_k?: number;
    include_inactive?: boolean;
  }) {
    const project = slugify(input.project || DEFAULT_PROJECT);
    const qTokens = uniqueTokens(input.query);
    const qConcepts = concepts(input.query, 12);
    const qVector = await embedText(input.query);
    const topK = Math.min(Math.max(input.top_k || 10, 1), 100);
    const candidates = this.data.memories
      .filter((memory) => memory.project === project)
      .filter((memory) => input.include_inactive || memory.active)
      .filter((memory) => !input.user_id || !memory.user_id || memory.user_id === input.user_id)
      .filter((memory) => !input.session_id || memory.session_id === input.session_id || !input.session_id)
      .filter((memory) => !input.agent_id || memory.agent_id === input.agent_id || !memory.agent_id)
      .filter((memory) => !input.task_id || memory.task_id === input.task_id || !memory.task_id);
    const docs = candidates.map((memory) => ({
      memory,
      tokens: tokenize(`${memory.content} ${memory.memory_type} ${JSON.stringify(memory.metadata)}`),
    }));
    const avgDocLength = docs.reduce((sum, doc) => sum + doc.tokens.length, 0) / Math.max(docs.length, 1);
    const docFreq = new Map<string, number>();
    for (const doc of docs) {
      for (const token of new Set(doc.tokens)) {
        docFreq.set(token, (docFreq.get(token) || 0) + 1);
      }
    }
    const branchScores = docs
      .map((memory) => {
        const termFreq = new Map<string, number>();
        for (const token of memory.tokens) termFreq.set(token, (termFreq.get(token) || 0) + 1);
        const k1 = 1.2;
        const b = 0.75;
        let bm25 = 0;
        for (const token of qTokens) {
          const tf = termFreq.get(token) || 0;
          if (tf === 0) continue;
          const df = docFreq.get(token) || 0;
          const idf = Math.log(1 + (docs.length - df + 0.5) / (df + 0.5));
          const denom = tf + k1 * (1 - b + b * (memory.tokens.length / Math.max(avgDocLength, 1)));
          bm25 += idf * ((tf * (k1 + 1)) / denom);
        }
        const phrase = memory.memory.content.toLowerCase().includes(input.query.toLowerCase()) ? 3 : 0;
        const vector = cosine(qVector, memory.memory.embedding || hashEmbedding(memory.memory.content));
        const memoryConcepts = Array.isArray(memory.memory.metadata.concepts)
          ? memory.memory.metadata.concepts.map(String)
          : concepts(memory.memory.content);
        const conceptOverlap = qConcepts.filter((concept) => memoryConcepts.includes(concept)).length;
        const graph = conceptOverlap + this.relatedConceptBoost(project, qConcepts, memoryConcepts);
        const ageHours = Math.max(1, (Date.now() - Date.parse(memory.memory.created_at)) / 36e5);
        const recency = 1 / Math.sqrt(ageHours);
        const lastAccess = typeof memory.memory.metadata.last_accessed_at === "string" ? Date.parse(memory.memory.metadata.last_accessed_at) : 0;
        const accessAgeHours = lastAccess ? Math.max(1, (Date.now() - lastAccess) / 36e5) : ageHours;
        const accessCount = Number(memory.memory.metadata.access_count || 0);
        const strength = Number(memory.memory.metadata.strength || memory.memory.importance || 0.5);
        const durability = memory.memory.memory_type === "semantic" ? 0.7 : memory.memory.memory_type === "procedural" ? 0.6 : memory.memory.memory_type === "correction" ? 0.5 : memory.memory.memory_type === "session_summary" ? 0.35 : 0;
        const decay = clamp(strength / Math.sqrt(ageHours / 24), 0, 1);
        const reinforcement = Math.log1p(accessCount) / 5 + (lastAccess ? 1 / Math.sqrt(accessAgeHours) / 5 : 0);
        return { memory: memory.memory, bm25: bm25 + phrase, vector, graph, recency, decay, durability, reinforcement };
      })
      .filter((item) => item.bm25 > 0 || item.vector > 0.05 || item.graph > 0);
    const rank = (key: "bm25" | "vector" | "graph") => {
      const map = new Map<string, number>();
      [...branchScores].sort((a, b) => b[key] - a[key]).forEach((item, index) => {
        if (item[key] > 0) map.set(item.memory.id, index + 1);
      });
      return map;
    };
    const bm25Rank = rank("bm25");
    const vectorRank = rank("vector");
    const graphRank = rank("graph");
    const scored = this.rerank(input.query, branchScores
      .map((item) => {
        const rrf =
          (bm25Rank.has(item.memory.id) ? 1 / (RRF_K + bm25Rank.get(item.memory.id)!) : 0) +
          (vectorRank.has(item.memory.id) ? 1 / (RRF_K + vectorRank.get(item.memory.id)!) : 0) +
          (graphRank.has(item.memory.id) ? 1 / (RRF_K + graphRank.get(item.memory.id)!) : 0);
        const score = rrf * 100 + item.memory.importance + item.memory.confidence + item.recency + item.decay + item.durability + item.reinforcement;
        return { ...item, score };
      })
      .sort((a, b) => b.score - a.score))
      .slice(0, topK);
    for (const item of scored) {
      item.memory.metadata.access_count = Number(item.memory.metadata.access_count || 0) + 1;
      item.memory.metadata.last_accessed_at = now();
      item.memory.metadata.strength = clamp(Number(item.memory.metadata.strength || item.memory.importance || 0.5) + 0.03);
      item.memory.updated_at = now();
    }
    if (scored.length) this.persist();
    return scored.map((item) => ({
      id: item.memory.id,
      score: Number(item.score.toFixed(4)),
      content: item.memory.content,
      memory: item.memory,
      metadata: item.memory.metadata,
      source: "local-memory",
      document: item.memory.session_id || item.memory.project,
      type: item.memory.memory_type,
      retrieval_source: "local_rrf",
      scores: { bm25: Number(item.bm25.toFixed(4)), vector: Number(item.vector.toFixed(4)), graph: Number(item.graph.toFixed(4)) },
    }));
  }

  rerank<T extends { memory: Memory; score: number; bm25: number; vector: number; graph: number }>(query: string, items: T[]) {
    const qTokens = uniqueTokens(query).filter((token) => !STOP_WORDS.has(token));
    return items
      .map((item) => {
        const content = item.memory.content.toLowerCase();
        const firstHit = qTokens
          .map((token) => content.indexOf(token))
          .filter((index) => index >= 0)
          .sort((a, b) => a - b)[0];
        const proximity = firstHit === undefined ? 0 : 1 / (1 + firstHit / 200);
        const exact = content.includes(query.toLowerCase()) ? 2 : 0;
        const lifecycle = item.memory.memory_type === "semantic" || item.memory.memory_type === "procedural" || item.memory.memory_type === "session_summary" ? 0.6 : 0;
        const evidence = Math.min(1, String(item.memory.metadata?.source_memory_ids || "").split(",").filter(Boolean).length / 8);
        const rerank_score = item.score + exact + proximity + lifecycle + evidence;
        return { ...item, score: rerank_score };
      })
      .sort((a, b) => b.score - a.score);
  }

  relatedConceptBoost(project: string, queryConcepts: string[], memoryConcepts: string[]) {
    if (queryConcepts.length === 0 || memoryConcepts.length === 0) return 0;
    const edges = this.graph(project).edges;
    let boost = 0;
    for (const edge of edges) {
      const queryTouches = queryConcepts.includes(edge.from) || queryConcepts.includes(edge.to);
      const memoryTouches = memoryConcepts.includes(edge.from) || memoryConcepts.includes(edge.to);
      if (queryTouches && memoryTouches) boost += Math.min(edge.weight, 5) / 5;
    }
    return boost;
  }

  graph(project?: string) {
    const slug = project ? slugify(project) : undefined;
    const nodes = new Map<string, { id: string; count: number }>();
    const edges = new Map<string, { from: string; to: string; weight: number }>();
    const memories = this.data.memories.filter((memory) => memory.active && (!slug || memory.project === slug));
    for (const memory of memories) {
      const cs = (Array.isArray(memory.metadata.concepts) ? memory.metadata.concepts.map(String) : concepts(memory.content)).slice(0, 8);
      for (const concept of cs) nodes.set(concept, { id: concept, count: (nodes.get(concept)?.count || 0) + 1 });
      for (let i = 0; i < cs.length; i++) {
        for (let j = i + 1; j < cs.length; j++) {
          const [from, to] = [cs[i], cs[j]].sort();
          const key = `${from}\0${to}`;
          const existing = edges.get(key);
          edges.set(key, { from, to, weight: (existing?.weight || 0) + 1 });
        }
      }
    }
    return {
      nodes: [...nodes.values()].sort((a, b) => b.count - a.count).slice(0, 100),
      edges: [...edges.values()].sort((a, b) => b.weight - a.weight).slice(0, 300),
    };
  }

  session(sessionId: string, project?: string, limit = 30) {
    const slug = slugify(project || DEFAULT_PROJECT);
    return this.data.memories
      .filter((memory) => memory.project === slug && memory.session_id === sessionId && memory.active)
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
      .slice(0, Math.min(Math.max(limit, 1), 200));
  }

  profile(userId: string, project?: string, limit = 100) {
    const slug = slugify(project || DEFAULT_PROJECT);
    return this.data.memories
      .filter((memory) => memory.project === slug && (!memory.user_id || memory.user_id === userId) && memory.active)
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
      .slice(0, Math.min(Math.max(limit, 1), 200));
  }

  delete(memoryId: string) {
    const memory = this.data.memories.find((item) => item.id === memoryId);
    if (!memory) return false;
    memory.active = false;
    memory.updated_at = now();
    this.persist();
    appendJournal("memory.deleted", { id: memoryId, project: memory.project });
    return true;
  }

  createShare(input: { project?: string; session_id: string; title?: string; expiry_days?: number }) {
    const project = slugify(input.project || DEFAULT_PROJECT);
    const memories = this.session(input.session_id, project, 100);
    const created = now();
    const share: Share = {
      id: `share_${randomUUID()}`,
      project,
      session_id: input.session_id,
      title: input.title || `RetainDB handoff: ${input.session_id}`,
      memory_ids: memories.map((memory) => memory.id),
      created_at: created,
      expires_at: input.expiry_days ? new Date(Date.now() + input.expiry_days * 864e5).toISOString() : undefined,
    };
    this.data.shares.push(share);
    this.persist();
    appendJournal("share.created", { id: share.id, project, session_id: share.session_id, memory_count: share.memory_ids.length });
    return { ...share, memories, share_id: share.id };
  }

  resumeShare(shareId: string, newSessionId?: string) {
    const share = this.data.shares.find((item) => item.id === shareId);
    if (!share) return null;
    const memories = this.data.memories.filter((memory) => share.memory_ids.includes(memory.id));
    return {
      share,
      session_id: newSessionId || `resumed-${Date.now()}`,
      context: memories.map((memory) => `- ${memory.content}`).join("\n"),
      memories,
    };
  }

  stats() {
    return {
      projects: this.data.projects.length,
      memories: this.data.memories.filter((memory) => memory.active).length,
      sessions: new Set(this.data.memories.map((memory) => memory.session_id).filter(Boolean)).size,
      shares: this.data.shares.length,
      store_path: STORE_PATH,
      journal_path: JOURNAL_PATH,
      embedding_provider: EMBEDDING_PROVIDER,
    };
  }

  async reembed(project?: string) {
    const slug = project ? slugify(project) : undefined;
    let updated = 0;
    for (const memory of this.data.memories.filter((item) => item.active && (!slug || item.project === slug))) {
      memory.embedding = await embedText(memory.content);
      memory.metadata = { ...memory.metadata, embedding_provider: EMBEDDING_PROVIDER };
      memory.updated_at = now();
      updated += 1;
    }
    this.persist();
    appendJournal("embeddings.refreshed", { project: slug || "all", updated, provider: EMBEDDING_PROVIDER });
    return { updated, provider: EMBEDDING_PROVIDER };
  }

  async contextPack(input: {
    project?: string;
    query: string;
    cwd?: string;
    files?: string[];
    tool_output?: string;
    previous_context_hash?: string;
    token_budget?: number;
    include_memory?: boolean;
  }) {
    const project = slugify(input.project || DEFAULT_PROJECT);
    const budget = Math.min(Math.max(Number(input.token_budget || 1600), 300), 8000);
    const cwd = resolve(input.cwd || process.cwd());
    const entries: ContextSnapshot["entries"] = [];
    let remaining = budget;

    const memoryResults = input.include_memory === false ? [] : await this.search({ project, query: input.query, top_k: 8 });
    const memoryBlock = memoryResults.map((result) => `- ${result.content}`).join("\n");
    if (memoryBlock) {
      const content = `Relevant memory:\n${truncateTokens(memoryBlock, Math.min(remaining, Math.floor(budget * 0.35)))}`;
      entries.push({ kind: "memory", id: "memory", hash: hashString(content), title: "Relevant memory", content });
      remaining -= estimateTokens(content);
    }

    if (input.tool_output) {
      const content = `Compressed tool output:\n${compressToolOutput(input.tool_output, Math.min(remaining, Math.floor(budget * 0.25)))}`;
      entries.push({ kind: "tool_output", id: "tool_output", hash: hashString(content), title: "Compressed tool output", content });
      remaining -= estimateTokens(content);
    }

    const mapped = codeMap(cwd, input.query, 12);
    const selectedFiles = Array.from(new Set([...(input.files || []), ...mapped.filter((item) => item.score > 0).slice(0, 6).map((item) => item.file)]));
    const chunks = packFileChunks(cwd, selectedFiles, input.query, Math.max(120, remaining));
    for (const chunk of chunks) {
      if (remaining <= 80) break;
      const content = truncateTokens(chunk.content, Math.min(chunk.tokens, remaining));
      entries.push({ kind: "file_chunk", id: chunk.file, hash: chunk.hash, title: chunk.file, content });
      remaining -= estimateTokens(content);
    }

    const mapContent = mapped.slice(0, 30).map((item) => `- ${item.file}${item.symbols.length ? `: ${item.symbols.slice(0, 8).join(", ")}` : ""}`).join("\n");
    if (mapContent && remaining > 100) {
      const content = `Code map:\n${truncateTokens(mapContent, Math.min(remaining, 300))}`;
      entries.push({ kind: "code_map", id: "code_map", hash: hashString(content), title: "Code map", content });
      remaining -= estimateTokens(content);
    }

    const prior = input.previous_context_hash ? this.data.contextSnapshots.find((item) => item.hash === input.previous_context_hash) : undefined;
    const priorHashes = new Map((prior?.entries || []).map((entry) => [`${entry.kind}:${entry.id}`, entry.hash]));
    const changed = entries.filter((entry) => priorHashes.get(`${entry.kind}:${entry.id}`) !== entry.hash);
    const removed = prior ? prior.entries.filter((entry) => !entries.some((next) => next.kind === entry.kind && next.id === entry.id)).map((entry) => ({ kind: entry.kind, id: entry.id, title: entry.title })) : [];
    const context = entries.map((entry) => entry.content).join("\n\n---\n\n");
    const deltaContext = changed.map((entry) => entry.content).join("\n\n---\n\n");
    const snapshot: ContextSnapshot = {
      hash: hashString(context),
      project,
      query: input.query,
      entries,
      created_at: now(),
    };
    this.data.contextSnapshots = [snapshot, ...this.data.contextSnapshots.filter((item) => item.hash !== snapshot.hash)].slice(0, 80);
    this.persist();
    appendJournal("context.packed", { project, hash: snapshot.hash, previous_context_hash: input.previous_context_hash, entries: entries.length, changed: changed.length, budget });
    return {
      context,
      delta_context: prior ? deltaContext || "No meaningful context changes since the previous pack." : context,
      context_hash: snapshot.hash,
      previous_context_hash: input.previous_context_hash || null,
      token_budget: budget,
      estimated_tokens: estimateTokens(context),
      estimated_delta_tokens: estimateTokens(prior ? deltaContext : context),
      compression_ratio: Number((estimateTokens(context) / Math.max(1, entries.reduce((sum, entry) => sum + estimateTokens(entry.content), 0))).toFixed(4)),
      changed: changed.map((entry) => ({ kind: entry.kind, id: entry.id, title: entry.title, hash: entry.hash })),
      removed,
      entries: entries.map((entry) => ({ kind: entry.kind, id: entry.id, title: entry.title, hash: entry.hash })),
    };
  }

  snapshot(project?: string) {
    const slug = project ? slugify(project) : undefined;
    const memories = this.data.memories
      .filter((memory) => !slug || memory.project === slug)
      .filter((memory) => memory.active)
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
    const sessions = Array.from(new Set(memories.map((memory) => memory.session_id).filter(Boolean))).map((sessionId) => {
      const sessionMemories = memories.filter((memory) => memory.session_id === sessionId);
      return {
        id: sessionId,
        project: sessionMemories[0]?.project || slug || DEFAULT_PROJECT,
        memory_count: sessionMemories.length,
        last_seen: sessionMemories[0]?.created_at,
        summary: sessionMemories.slice(0, 5).map((memory) => memory.content).join("\n"),
      };
    });
    const type_counts = memories.reduce<Record<string, number>>((acc, memory) => {
      acc[memory.memory_type] = (acc[memory.memory_type] || 0) + 1;
      return acc;
    }, {});
    return { stats: this.stats(), projects: this.data.projects, memories: memories.slice(0, 200), sessions, type_counts, graph: this.graph(slug) };
  }

  replay(sessionId: string, project?: string) {
    const memories = this.session(sessionId, project, 500).reverse();
    let previousTime: number | null = null;
    return {
      session_id: sessionId,
      events: memories.map((memory, index) => ({
        ...(() => {
          const currentTime = Date.parse(memory.created_at);
          const delta = previousTime === null ? 0 : Math.max(0, currentTime - previousTime);
          previousTime = currentTime;
          const event = memory.metadata?.event && typeof memory.metadata.event === "object" ? memory.metadata.event as Record<string, unknown> : {};
          return {
            index,
            id: memory.id,
            type: memory.memory_type,
            timestamp: memory.created_at,
            elapsed_ms: delta,
            title: memory.content.split("\n")[0]?.slice(0, 140) || memory.memory_type,
            content: memory.content,
            tool: event.toolName || event.tool_name || memory.metadata?.toolName || null,
            files: Array.isArray(event.filePaths) ? event.filePaths : [],
            metadata: memory.metadata,
          };
        })(),
      })),
    };
  }

  async consolidate(project?: string) {
    const slug = project ? slugify(project) : undefined;
    let duplicates_removed = 0;
    let summaries_created = 0;
    let decayed_memories = 0;
    const seen = new Map<string, Memory>();
    for (const memory of this.data.memories.filter((item) => item.active && (!slug || item.project === slug))) {
      const key = createHash("sha1").update(`${memory.project}:${memory.content.toLowerCase().replace(/\s+/g, " ").trim()}`).digest("hex");
      const prior = seen.get(key);
      if (prior) {
        memory.active = false;
        memory.updated_at = now();
        duplicates_removed += 1;
        appendJournal("memory.superseded", { id: memory.id, project: memory.project, reason: "duplicate", prior_id: prior.id });
      } else {
        seen.set(key, memory);
      }
    }
    const sessions = new Set(this.data.memories.filter((memory) => memory.active && memory.session_id && (!slug || memory.project === slug)).map((memory) => `${memory.project}\0${memory.session_id}`));
    for (const sessionKey of sessions) {
      const [sessionProject, sessionId] = sessionKey.split("\0");
      const memories = this.session(sessionId, sessionProject, 50).filter((memory) => memory.memory_type !== "session_summary");
      if (memories.length < 4) continue;
      const content = `Session ${sessionId} consolidated summary:\n${memories.slice(0, 12).map((memory) => `- ${memory.content.split("\n")[0]}`).join("\n")}`;
      const before = this.data.memories.length;
      await this.addMemory({
        project: sessionProject,
        session_id: sessionId,
        memory_type: "session_summary",
        content,
        importance: 0.85,
        metadata: { source: "consolidation", source_memory_ids: memories.map((memory) => memory.id) },
      });
      if (this.data.memories.length > before) summaries_created += 1;
      const decisions = memories.filter((memory) => /decision|constraint|fix|resolved|prefer|use /i.test(memory.content)).slice(0, 8);
      if (decisions.length >= 2) {
        await this.addMemory({
          project: sessionProject,
          session_id: sessionId,
          memory_type: "semantic",
          content: `Stable project knowledge from ${sessionId}:\n${decisions.map((memory) => `- ${memory.content.split("\n")[0]}`).join("\n")}`,
          importance: 0.9,
          metadata: { source: "semantic_consolidation", source_memory_ids: decisions.map((memory) => memory.id) },
        });
      }
      const workflows = memories.filter((memory) => /workflow|steps?|command|run|test|deploy|build|fix/i.test(memory.content)).slice(0, 8);
      if (workflows.length >= 2) {
        await this.addMemory({
          project: sessionProject,
          session_id: sessionId,
          memory_type: "procedural",
          content: `Useful workflow from ${sessionId}:\n${workflows.map((memory) => `- ${memory.content.split("\n")[0]}`).join("\n")}`,
          importance: 0.82,
          metadata: { source: "procedural_consolidation", source_memory_ids: workflows.map((memory) => memory.id) },
        });
      }
    }
    for (const memory of this.data.memories.filter((item) => item.active && (!slug || item.project === slug))) {
      const ageDays = Math.max(0, (Date.now() - Date.parse(memory.created_at)) / 864e5);
      const strength = Number(memory.metadata.strength || memory.importance || 0.5);
      const accessCount = Number(memory.metadata.access_count || 0);
      const durable = ["semantic", "procedural", "correction", "session_summary"].includes(memory.memory_type);
      if (!durable && ageDays > 14 && accessCount === 0 && strength < 0.45) {
        memory.active = false;
        memory.updated_at = now();
        memory.metadata.decayed_at = memory.updated_at;
        decayed_memories += 1;
        appendJournal("memory.decayed", { id: memory.id, project: memory.project, age_days: Number(ageDays.toFixed(2)), strength });
      }
    }
    this.persist();
    appendJournal("consolidation.completed", { project: slug || "all", duplicates_removed, summaries_created, decayed_memories });
    return { duplicates_removed, summaries_created, decayed_memories };
  }
}

function json(c: any, payload: Record<string, unknown>, status = 200) {
  return c.json({ success: status < 400, ...payload, trace_id: randomUUID() }, status);
}

function createApp(runtime: LocalMemoryRuntime) {
  const app = new Hono();
  app.get("/", (c) => json(c, {
    name: "RetainDB Local",
    version: "0.1.0",
    message: "Persistent memory for coding agents. Runs on your machine.",
    endpoints: {
      health: "GET /health",
      context: "POST /v1/context/query",
      memory_write: "POST /v1/memory",
      memory_search: "POST /v1/memory/search",
      context_pack: "POST /v1/context/pack",
      context_delta: "POST /v1/context/delta",
      memory_ingest: "POST /v1/memory/ingest/session",
      agent_event: "POST /v1/agent-events",
    },
  }));
  app.get("/health", (c) => json(c, { status: "ok", local: true, stats: runtime.stats() }));
  app.get("/retaindb/health", (c) => json(c, { status: "ok", local: true, stats: runtime.stats() }));
  app.get("/retaindb/snapshot", (c) => json(c, runtime.snapshot(c.req.query("project"))));
  app.get("/retaindb/graph", (c) => json(c, runtime.graph(c.req.query("project"))));
  app.get("/retaindb/replay/:sessionId", (c) => json(c, runtime.replay(c.req.param("sessionId"), c.req.query("project"))));
  app.post("/retaindb/consolidate", async (c) => {
    const body = await c.req.json().catch(() => ({} as any));
    return json(c, await runtime.consolidate(body.project));
  });
  app.get("/v1/projects", (c) => json(c, { projects: runtime.listProjects() }));
  app.post("/v1/projects", async (c) => {
    const body = await c.req.json().catch(() => ({} as any));
    const project = runtime.ensureProject(body.name || body.slug || DEFAULT_PROJECT);
    return json(c, project);
  });
  app.post("/v1/memory", async (c) => {
    const body = await c.req.json();
    const memory = await runtime.addMemory(body);
    return json(c, { memory_id: memory.id, id: memory.id, stored: true, memory });
  });
  app.post("/v1/memory/bulk", async (c) => {
    const body = await c.req.json();
    const memories = Array.isArray(body.memories) ? body.memories : [];
    const stored = await Promise.all(memories.map((memory: any) => runtime.addMemory({ ...memory, project: body.project || memory.project })));
    return json(c, { memories_created: stored.length, memories: stored });
  });
  app.post("/v1/memory/search", async (c) => {
    const body = await c.req.json();
    const results = await runtime.search(body);
    return json(c, { results, memories: results.map((result) => result.memory), count: results.length });
  });
  app.post("/v1/context/query", async (c) => {
    const body = await c.req.json();
    const results = await runtime.search(body);
    return json(c, {
      results,
      memories: body.include_memories === false ? [] : results.map((result) => result.memory),
      context: results.map((result) => `- ${result.content}`).join("\n"),
      meta: {
        query: body.query,
        total: results.length,
        latency_ms: 0,
        cache_hit: false,
        tokens_used: 0,
        context_hash: createHash("sha256").update(results.map((result) => result.content).join("\n")).digest("hex"),
      },
    });
  });
  app.post("/v1/context/pack", async (c) => {
    const body = await c.req.json().catch(() => ({} as any));
    return json(c, await runtime.contextPack(body));
  });
  app.post("/v1/context/delta", async (c) => {
    const body = await c.req.json().catch(() => ({} as any));
    return json(c, await runtime.contextPack({ ...body, previous_context_hash: body.previous_context_hash || body.context_hash }));
  });
  app.post("/v1/context/compress-output", async (c) => {
    const body = await c.req.json().catch(() => ({} as any));
    const compressed = compressToolOutput(String(body.output || body.tool_output || ""), Number(body.token_budget || 500));
    return json(c, {
      compressed,
      estimated_tokens: estimateTokens(compressed),
      original_estimated_tokens: estimateTokens(String(body.output || body.tool_output || "")),
      compression_ratio: Number((estimateTokens(compressed) / Math.max(1, estimateTokens(String(body.output || body.tool_output || "")))).toFixed(4)),
    });
  });
  app.post("/v1/context/code-map", async (c) => {
    const body = await c.req.json().catch(() => ({} as any));
    return json(c, { files: codeMap(String(body.cwd || process.cwd()), String(body.query || ""), Number(body.limit || 80)) });
  });
  app.post("/v1/memory/ingest/session", async (c) => {
    const body = await c.req.json();
    const result = await runtime.ingestSession(body);
    return json(c, {
      memories_created: result.memories_created,
      skipped: result.skipped,
      relations_created: 0,
      memories_invalidated: 0,
      memories: result.memories,
    });
  });
  app.post("/v1/agent-events", async (c) => {
    const body = await c.req.json();
    const result = await runtime.ingestSession({
      project: body.project,
      session_id: body.session_id || `session-${Date.now()}`,
      user_id: body.user_id,
      agent_id: body.agent_id,
      task_id: body.task_id,
      events: [body.event || body],
      messages: body.messages || [],
    });
    return json(c, { stored: true, memories_created: result.memories_created, skipped: result.skipped, memories: result.memories });
  });
  app.post("/retaindb/observe", async (c) => {
    const body = await c.req.json().catch(() => ({} as any));
    const hookType = String(body.hookType || body.hook_type || "observation");
    const data = body.data && typeof body.data === "object" ? body.data as Record<string, unknown> : {};
    const summary =
      typeof data.prompt === "string" ? `Prompt: ${data.prompt}` :
      typeof data.tool_name === "string" ? `${data.tool_name}: ${String(data.tool_output || data.tool_response || "").slice(0, 2000)}` :
      typeof data.message === "string" ? data.message :
      `${hookType} captured`;
    const result = await runtime.ingestSession({
      project: String(body.project || DEFAULT_PROJECT),
      session_id: String(body.sessionId || body.session_id || `session-${Date.now()}`),
      agent_id: String(body.agentId || body.agent_id || "agent"),
      events: [{
        kind: hookType,
        summary,
        details: JSON.stringify(data).slice(0, 12000),
        timestamp: String(body.timestamp || now()),
        toolName: typeof data.tool_name === "string" ? data.tool_name : undefined,
      }],
      messages: [],
    });
    return json(c, { stored: true, memories_created: result.memories_created, skipped: result.skipped });
  });
  app.post("/retaindb/session/start", async (c) => {
    const body = await c.req.json().catch(() => ({} as any));
    const sessionId = String(body.sessionId || body.session_id || `session-${Date.now()}`);
    const project = String(body.project || DEFAULT_PROJECT);
    await runtime.ingestSession({
      project,
      session_id: sessionId,
      agent_id: "agent",
      events: [{ kind: "session_start", summary: `Session started in ${String(body.cwd || project)}`, timestamp: now() }],
    });
    const context = (await runtime.search({ project, query: "recent project decisions constraints workflow", top_k: 8 }))
      .map((result) => `- ${result.content}`)
      .join("\n");
    return json(c, { sessionId, context });
  });
  app.post("/retaindb/session/end", async (c) => {
    const body = await c.req.json().catch(() => ({} as any));
    const sessionId = String(body.sessionId || body.session_id || "unknown");
    const result = await runtime.ingestSession({
      project: String(body.project || DEFAULT_PROJECT),
      session_id: sessionId,
      agent_id: "agent",
      events: [{ kind: "session_end", summary: `Session ended: ${sessionId}`, timestamp: now() }],
    });
    return json(c, { stored: true, memories_created: result.memories_created, skipped: result.skipped });
  });
  app.post("/retaindb/summarize", async (c) => {
    const body = await c.req.json().catch(() => ({} as any));
    const sessionId = String(body.sessionId || body.session_id || "unknown");
    const memories = runtime.session(sessionId, String(body.project || DEFAULT_PROJECT), 20);
    if (memories.length > 0) {
      await runtime.addMemory({
        project: String(body.project || DEFAULT_PROJECT),
        session_id: sessionId,
        memory_type: "session_summary",
        content: `Session ${sessionId} summary:\n${memories.map((memory) => `- ${memory.content}`).join("\n")}`,
        metadata: { source: "session_summary", memory_count: memories.length },
      });
    }
    return json(c, { summarized: true, memories_seen: memories.length });
  });
  app.post("/retaindb/smart-search", async (c) => {
    const body = await c.req.json().catch(() => ({} as any));
    const results = await runtime.search({
      project: String(body.project || DEFAULT_PROJECT),
      query: String(body.query || body.q || ""),
      top_k: Number(body.limit || body.top_k || 10),
    });
    return json(c, { results, memories: results.map((result) => result.memory) });
  });
  app.get("/v1/memory/session/:sessionId", (c) => {
    const memories = runtime.session(c.req.param("sessionId"), c.req.query("project"), Number(c.req.query("limit") || 30));
    return json(c, { memories, count: memories.length });
  });
  app.get("/v1/memory/profile/:userId", (c) => {
    const memories = runtime.profile(c.req.param("userId"), c.req.query("project"), Number(c.req.query("limit") || 100));
    return json(c, { memories, count: memories.length });
  });
  app.get("/v1/memories", (c) => {
    const memories = runtime.profile(c.req.query("user_id") || "local-user", c.req.query("project"), Number(c.req.query("limit") || 100));
    return json(c, { memories });
  });
  app.delete("/v1/memory/:memoryId", (c) => {
    const deleted = runtime.delete(c.req.param("memoryId"));
    return json(c, { deleted: deleted ? c.req.param("memoryId") : null });
  });
  app.post("/v1/context/share", async (c) => {
    const body = await c.req.json();
    const share = runtime.createShare(body);
    return json(c, share);
  });
  app.post("/v1/context/resume", async (c) => {
    const body = await c.req.json();
    const result = runtime.resumeShare(body.share_id, body.new_session_id);
    if (!result) return json(c, { error: { code: "NOT_FOUND", message: "Share not found" } }, 404);
    return json(c, result);
  });
  app.notFound((c) => json(c, { error: { code: "NOT_FOUND", message: "Route not found" } }, 404));
  return app;
}

function viewerHtml(apiPort: number) {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>RetainDB Local</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: #f7f7f4; color: #191a1c; }
    header { padding: 24px 28px 16px; border-bottom: 1px solid #ddd9d0; background: #ffffff; }
    h1 { margin: 0; font-size: 24px; letter-spacing: 0; }
    .sub { margin-top: 6px; color: #62646a; font-size: 14px; }
    main { display: grid; grid-template-columns: 280px 1fr; min-height: calc(100vh - 86px); }
    aside { border-right: 1px solid #ddd9d0; padding: 18px; background: #fbfbf8; }
    section { padding: 18px; }
    .stats { display: grid; gap: 10px; }
    .stat { border: 1px solid #ddd9d0; background: #fff; border-radius: 8px; padding: 12px; }
    .stat strong { display: block; font-size: 22px; }
    .toolbar { display: flex; gap: 8px; margin-bottom: 14px; }
    input { flex: 1; min-width: 0; border: 1px solid #c9c6be; border-radius: 6px; padding: 9px 10px; font: inherit; }
    button { border: 1px solid #191a1c; background: #191a1c; color: #fff; border-radius: 6px; padding: 9px 12px; font: inherit; cursor: pointer; }
    .grid { display: grid; gap: 10px; }
    .item { border: 1px solid #ddd9d0; border-radius: 8px; background: #fff; padding: 12px; }
    .item[data-session] { cursor: pointer; }
    .meta { color: #62646a; font-size: 12px; margin-bottom: 6px; display: flex; gap: 8px; flex-wrap: wrap; }
    .timeline { display: grid; gap: 8px; }
    .event { border-left: 3px solid #191a1c; padding: 8px 10px; background: #fbfbf8; border-radius: 0 6px 6px 0; }
    .event.active { background: #eef6ff; border-left-color: #2457c5; }
    .graphbox { height: 240px; border: 1px solid #ddd9d0; border-radius: 8px; background: #fff; overflow: hidden; }
    .graphbox svg { width: 100%; height: 100%; display: block; }
    .node { cursor: pointer; }
    .node text { font-size: 11px; fill: #191a1c; pointer-events: none; }
    .edge { stroke: #c9c6be; stroke-width: 1.25; }
    pre { white-space: pre-wrap; margin: 0; font: inherit; line-height: 1.45; }
    @media (max-width: 800px) { main { grid-template-columns: 1fr; } aside { border-right: 0; border-bottom: 1px solid #ddd9d0; } }
  </style>
</head>
<body>
  <header>
    <h1>RetainDB Local</h1>
    <div class="sub">Live memory browser for the local runtime on :${apiPort}</div>
  </header>
  <main>
    <aside>
      <div class="stats" id="stats"></div>
      <h3>Sessions</h3>
      <div class="grid" id="sessions"></div>
      <h3>Graph</h3>
      <div class="grid" id="graph"></div>
    </aside>
    <section>
      <div class="toolbar">
        <input id="query" placeholder="Search memories" />
        <button id="search">Search</button>
        <button id="refresh">Refresh</button>
      </div>
      <div class="grid" id="replay" style="margin-bottom:14px;"></div>
      <div class="grid" id="memories"></div>
    </section>
  </main>
  <script>
    const api = location.protocol + '//' + location.hostname + ':${apiPort}';
    const statsEl = document.getElementById('stats');
    const memoriesEl = document.getElementById('memories');
    const sessionsEl = document.getElementById('sessions');
    const graphEl = document.getElementById('graph');
    const replayEl = document.getElementById('replay');
    const queryEl = document.getElementById('query');
    function esc(s) { return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
    function renderStats(stats, typeCounts) {
      statsEl.innerHTML = ['memories','sessions','projects','shares'].map(k => '<div class="stat"><strong>' + esc(stats[k]) + '</strong><span>' + k + '</span></div>').join('') +
        '<div class="stat"><span>' + esc(Object.entries(typeCounts || {}).map(([k,v]) => k + ':' + v).join(' · ') || 'no types yet') + '</span></div>';
    }
    function renderMemories(memories) {
      memoriesEl.innerHTML = (memories || []).map(m => '<div class="item"><div class="meta"><span>' + esc(m.memory_type || m.type) + '</span><span>' + esc(m.project) + '</span><span>' + esc(m.session_id || '') + '</span><span>' + esc(m.created_at || '') + '</span></div><pre>' + esc(m.content) + '</pre></div>').join('') || '<div class="item">No memories yet.</div>';
    }
    function renderSessions(sessions) {
      sessionsEl.innerHTML = (sessions || []).slice(0, 20).map(s => '<div class="item" data-session="' + esc(s.id) + '"><div class="meta"><span>' + esc(s.memory_count) + ' memories</span><span>' + esc(s.last_seen || '') + '</span></div><pre>' + esc(s.id) + '</pre></div>').join('') || '<div class="item">No sessions yet.</div>';
      for (const node of sessionsEl.querySelectorAll('[data-session]')) node.onclick = () => replay(node.getAttribute('data-session'));
    }
    function renderGraph(graph) {
      const nodes = ((graph && graph.nodes) || []).slice(0, 24);
      const edges = ((graph && graph.edges) || []).filter(e => nodes.some(n => n.id === e.from) && nodes.some(n => n.id === e.to)).slice(0, 60);
      if (!nodes.length) {
        graphEl.innerHTML = '<div class="item">No graph yet.</div>';
        return;
      }
      const w = 260, h = 240, cx = w / 2, cy = h / 2;
      const maxCount = Math.max(...nodes.map(n => n.count || 1), 1);
      const positioned = nodes.map((n, i) => {
        const angle = (Math.PI * 2 * i) / nodes.length;
        const radius = 46 + Math.min(62, (nodes.length * 4));
        return { ...n, x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius, r: 5 + 10 * ((n.count || 1) / maxCount) };
      });
      const byId = Object.fromEntries(positioned.map(n => [n.id, n]));
      const edgeSvg = edges.map(e => byId[e.from] && byId[e.to] ? '<line class="edge" x1="' + byId[e.from].x + '" y1="' + byId[e.from].y + '" x2="' + byId[e.to].x + '" y2="' + byId[e.to].y + '" />' : '').join('');
      const nodeSvg = positioned.map(n => '<g class="node" data-concept="' + esc(n.id) + '"><circle cx="' + n.x + '" cy="' + n.y + '" r="' + n.r + '" fill="#eef6ff" stroke="#2457c5"></circle><text x="' + (n.x + n.r + 3) + '" y="' + (n.y + 4) + '">' + esc(n.id.slice(0, 18)) + '</text></g>').join('');
      graphEl.innerHTML = '<div class="graphbox"><svg viewBox="0 0 ' + w + ' ' + h + '">' + edgeSvg + nodeSvg + '</svg></div><div class="item"><div class="meta"><span>' + esc(nodes.length) + ' nodes</span><span>' + esc(edges.length) + ' edges</span></div><pre>' + esc(nodes.slice(0, 10).map(n => n.id + ':' + n.count).join('\\n')) + '</pre></div>';
      for (const node of graphEl.querySelectorAll('[data-concept]')) node.onclick = () => { queryEl.value = node.getAttribute('data-concept') || ''; search(); };
    }
    async function replay(sessionId) {
      const res = await fetch(api + '/retaindb/replay/' + encodeURIComponent(sessionId));
      const body = await res.json();
      const events = body.events || [];
      replayEl.innerHTML = '<div class="item"><div class="meta"><span>Replay</span><span>' + esc(sessionId) + '</span><span>' + esc(events.length) + ' events</span><button id="stepReplay" style="margin-left:auto">Step</button></div><div class="timeline">' + events.map((e, i) => '<div class="event" data-step="' + i + '"><div class="meta"><span>#' + esc(i + 1) + '</span><span>' + esc(e.type) + '</span><span>+' + esc(e.elapsed_ms || 0) + 'ms</span><span>' + esc(e.tool || '') + '</span></div><pre>' + esc(e.title) + '</pre></div>').join('') + '</div></div>';
      let index = -1;
      const step = () => {
        const nodes = Array.from(replayEl.querySelectorAll('.event'));
        nodes.forEach(n => n.classList.remove('active'));
        index = Math.min(index + 1, nodes.length - 1);
        if (nodes[index]) nodes[index].classList.add('active');
      };
      document.getElementById('stepReplay').onclick = step;
    }
    async function refresh() {
      const res = await fetch(api + '/retaindb/snapshot');
      const snap = await res.json();
      renderStats(snap.stats || {}, snap.type_counts || {});
      renderMemories(snap.memories || []);
      renderSessions(snap.sessions || []);
      renderGraph(snap.graph || {});
    }
    async function search() {
      const query = queryEl.value.trim();
      if (!query) return refresh();
      const res = await fetch(api + '/v1/memory/search', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ query, top_k: 50 }) });
      const body = await res.json();
      renderMemories((body.results || []).map(r => r.memory || r));
    }
    document.getElementById('refresh').onclick = refresh;
    document.getElementById('search').onclick = search;
    queryEl.addEventListener('keydown', e => { if (e.key === 'Enter') search(); });
    refresh();
    setInterval(refresh, 5000);
  </script>
</body>
</html>`;
}

function createViewerApp(apiPort: number) {
  const app = new Hono();
  app.get("/", (c) => c.html(viewerHtml(apiPort)));
  return app;
}

function arg(name: string) {
  const prefix = `--${name}=`;
  return process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length);
}

function mcpEnv(baseUrl: string, project: string) {
  return { RETAINDB_BASE_URL: baseUrl, RETAINDB_PROJECT: project };
}

function connectConfig(target: string, baseUrl: string, project: string) {
  const env = mcpEnv(baseUrl, project);
  const hookCommand = ["npx", "-y", "@retaindb/local", "hook"];
  const mcpCommand = ["npx", "-y", "@retaindb/local", "mcp"];
  if (target === "codex") {
    return [
      "[mcp_servers.retaindb]",
      'command = "npx"',
      'args = ["-y", "@retaindb/local", "mcp"]',
      "",
      "[mcp_servers.retaindb.env]",
      `RETAINDB_BASE_URL = "${baseUrl}"`,
      `RETAINDB_PROJECT = "${project}"`,
      "",
      "# Optional hook commands for Codex user hooks:",
      `# ${hookCommand.join(" ")} --kind=tool_result --agent=codex`,
    ].join("\n");
  }
  if (target === "opencode") {
    return JSON.stringify({
      mcp: { retaindb: { type: "local", command: mcpCommand, env, enabled: true } },
      plugin: ["./.retaindb/opencode/retaindb-capture.ts"],
      hooks: { postToolUse: hookCommand.concat(["--kind=tool_result", "--agent=opencode"]) },
    }, null, 2);
  }
  return JSON.stringify({
    mcpServers: { retaindb: { command: "npx", args: ["-y", "@retaindb/local", "mcp"], env } },
    hooks: {
      UserPromptSubmit: hookCommand.concat(["--kind=prompt", "--agent=claude-code"]),
      PostToolUse: hookCommand.concat(["--kind=tool_result", "--agent=claude-code"]),
      Stop: hookCommand.concat(["--kind=session_end", "--agent=claude-code"]),
    },
  }, null, 2);
}

function opencodePluginSource(baseUrl: string, project: string) {
  return `import type { Plugin } from "@opencode-ai/plugin";

const API = process.env.RETAINDB_BASE_URL || "${baseUrl}";
const PROJECT = process.env.RETAINDB_PROJECT || "${project}";

async function observe(sessionId: string, hookType: string, data: Record<string, unknown>) {
  try {
    await fetch(\`\${API.replace(/\\/+$/, "")}/retaindb/observe\`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hookType,
        sessionId,
        project: PROJECT,
        cwd: data.cwd || process.cwd(),
        timestamp: new Date().toISOString(),
        data,
      }),
      signal: AbortSignal.timeout(3000),
    });
  } catch {}
}

export const RetainDBCapturePlugin: Plugin = async (ctx) => {
  let activeSessionId: string | null = null;
  const projectPath = ctx.worktree || ctx.project?.id || process.cwd();
  return {
    event: async ({ event }) => {
      const type = event.type;
      const props = (event as any).properties || {};
      const sid = props.sessionID || props.session_id || activeSessionId || "opencode-session";
      if (type === "session.created") {
        activeSessionId = props.info?.id || props.sessionID || sid;
        await observe(activeSessionId, "session_start", { cwd: projectPath, info: props.info || {} });
      }
      if (type === "session.status" && props.status?.type === "idle") {
        await observe(sid, "session_idle", { cwd: projectPath, status: props.status });
      }
      if (type === "session.deleted") {
        await observe(sid, "session_end", { cwd: projectPath });
        if (sid === activeSessionId) activeSessionId = null;
      }
      if (type === "session.diff") {
        await observe(sid, "file_edit", { cwd: projectPath, diff: props.diff || [] });
      }
      if (type === "message.part.updated" && props.part?.type === "tool") {
        await observe(sid, props.part.state?.status === "error" ? "post_tool_failure" : "post_tool_use", {
          cwd: projectPath,
          tool_name: props.part.tool,
          state: props.part.state,
        });
      }
    },
    "chat.message": async (input, output) => {
      const sid = input.sessionID || activeSessionId || "opencode-session";
      const text = (output.parts || []).filter((part: any) => part.type === "text").map((part: any) => part.text || "").join("\\n");
      await observe(sid, "prompt_submit", { cwd: projectPath, prompt: text.slice(0, 8000), agent: input.agent || null });
    },
  };
};
`;
}

function writeConnectSnippets(target = "all") {
  const baseUrl = process.env.RETAINDB_BASE_URL || `http://localhost:${DEFAULT_PORT}`;
  const project = process.env.RETAINDB_PROJECT || DEFAULT_PROJECT;
  const targets = target === "all" ? ["codex", "claude-code", "opencode"] : [target];
  const outputRoot = process.env.INIT_CWD || process.cwd();
  const dir = join(outputRoot, ".retaindb", "agent-bridge");
  mkdirSync(dir, { recursive: true });
  for (const item of targets) {
    const ext = item === "codex" ? "toml" : "json";
    const dest = join(dir, `${item}.${ext}`);
    writeFileSync(dest, `${connectConfig(item, baseUrl, project)}\n`, "utf8");
    console.log(`Wrote ${item}: ${dest}`);
    if (item === "opencode") {
      const pluginDir = join(outputRoot, ".retaindb", "opencode");
      mkdirSync(pluginDir, { recursive: true });
      const pluginDest = join(pluginDir, "retaindb-capture.ts");
      writeFileSync(pluginDest, opencodePluginSource(baseUrl, project), "utf8");
      console.log(`Wrote opencode plugin: ${pluginDest}`);
    }
  }
  console.log("");
  console.log("Merge these snippets into the agent config. Start RetainDB Local with `npx -y @retaindb/local` first.");
}

function backupPath(path: string) {
  return `${path}.retaindb-backup-${Date.now()}`;
}

function readJsonFile(path: string) {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
  } catch {
    return {};
  }
}

function writeJsonFile(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) writeFileSync(backupPath(path), readFileSync(path));
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function stripTomlBlock(toml: string) {
  const lines = toml.split(/\r?\n/);
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "[mcp_servers.retaindb]" || trimmed === "[mcp_servers.retaindb.env]") {
      skipping = true;
      continue;
    }
    if (skipping && trimmed.startsWith("[") && trimmed !== "[mcp_servers.retaindb.env]") skipping = false;
    if (!skipping) out.push(line);
  }
  return out.join("\n").trimEnd();
}

function installCodexConfig(baseUrl: string, project: string) {
  const dir = join(homedir(), ".codex");
  const path = join(dir, "config.toml");
  mkdirSync(dir, { recursive: true });
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (current) writeFileSync(backupPath(path), current, "utf8");
  const block = connectConfig("codex", baseUrl, project);
  writeFileSync(path, `${stripTomlBlock(current)}\n\n${block}\n`, "utf8");
  return path;
}

function installClaudeConfig(baseUrl: string, project: string) {
  const path = join(homedir(), ".claude.json");
  const config = readJsonFile(path);
  config.mcpServers = {
    ...(config.mcpServers || {}),
    retaindb: { command: "npx", args: ["-y", "@retaindb/local", "mcp"], env: mcpEnv(baseUrl, project) },
  };
  writeJsonFile(path, config);
  const settingsPath = join(homedir(), ".claude", "settings.json");
  const settings = readJsonFile(settingsPath);
  settings.hooks = {
    ...(settings.hooks || {}),
    UserPromptSubmit: [{ hooks: [{ type: "command", command: "npx -y @retaindb/local hook --kind=prompt --agent=claude-code" }] }],
    PostToolUse: [{ hooks: [{ type: "command", command: "npx -y @retaindb/local hook --kind=tool_result --agent=claude-code" }] }],
    Stop: [{ hooks: [{ type: "command", command: "npx -y @retaindb/local hook --kind=session_end --agent=claude-code" }] }],
  };
  writeJsonFile(settingsPath, settings);
  return `${path}, ${settingsPath}`;
}

async function runMcp() {
  const [{ McpServer }, { StdioServerTransport }, zod] = await Promise.all([
    import("@modelcontextprotocol/sdk/server/mcp.js"),
    import("@modelcontextprotocol/sdk/server/stdio.js"),
    import("zod"),
  ]);
  const z = zod.z;
  const baseUrl = (process.env.RETAINDB_BASE_URL || `http://localhost:${DEFAULT_PORT}`).replace(/\/+$/, "");
  const project = process.env.RETAINDB_PROJECT || DEFAULT_PROJECT;
  const server = new McpServer({ name: "retaindb-local", version: "0.1.0" });
  const post = async (path: string, body: Record<string, unknown>) => {
    const res = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project, ...body }),
    });
    return res.json();
  };
  const get = async (path: string) => {
    const res = await fetch(`${baseUrl}${path}`);
    return res.json();
  };
  const out = (value: unknown) => ({ content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });

  server.tool("context", "Retrieve packed RetainDB Local context for the current task.", {
    query: z.string(),
    user_id: z.string().optional(),
    session_id: z.string().optional(),
    top_k: z.number().optional(),
  }, async (args: any) => out(await post("/v1/context/query", args)));

  server.tool("context_pack", "Build a small token-budgeted context pack from memory, relevant files, code map, and compressed tool output.", {
    query: z.string(),
    cwd: z.string().optional(),
    files: z.array(z.string()).optional(),
    tool_output: z.string().optional(),
    previous_context_hash: z.string().optional(),
    token_budget: z.number().optional(),
    include_memory: z.boolean().optional(),
  }, async (args: any) => out(await post("/v1/context/pack", args)));

  server.tool("context_delta", "Return only what changed since a previous RetainDB context pack.", {
    query: z.string(),
    previous_context_hash: z.string(),
    cwd: z.string().optional(),
    files: z.array(z.string()).optional(),
    tool_output: z.string().optional(),
    token_budget: z.number().optional(),
  }, async (args: any) => out(await post("/v1/context/delta", args)));

  server.tool("compress_output", "Compress terminal, test, build, or tool output while keeping failures and stack traces.", {
    output: z.string(),
    token_budget: z.number().optional(),
  }, async (args: any) => out(await post("/v1/context/compress-output", args)));

  server.tool("code_map", "Build a compact map of relevant files and symbols for a coding task.", {
    query: z.string().optional(),
    cwd: z.string().optional(),
    limit: z.number().optional(),
  }, async (args: any) => out(await post("/v1/context/code-map", args)));

  server.tool("remember", "Save a durable memory to RetainDB Local.", {
    content: z.string(),
    memory_type: z.string().optional(),
    user_id: z.string().optional(),
    session_id: z.string().optional(),
    importance: z.number().optional(),
  }, async (args: any) => out(await post("/v1/memory", args)));

  server.tool("recall", "Search RetainDB Local memories.", {
    query: z.string(),
    user_id: z.string().optional(),
    session_id: z.string().optional(),
    top_k: z.number().optional(),
  }, async (args: any) => out(await post("/v1/memory/search", args)));

  server.tool("session_history", "List memories for a RetainDB Local session.", {
    session_id: z.string(),
    limit: z.number().optional(),
  }, async (args: any) => out(await get(`/v1/memory/session/${encodeURIComponent(args.session_id)}?project=${encodeURIComponent(project)}&limit=${encodeURIComponent(String(args.limit || 30))}`)));

  server.tool("handoff", "Create a session handoff from RetainDB Local memories.", {
    session_id: z.string(),
    title: z.string().optional(),
    expiry_days: z.number().optional(),
  }, async (args: any) => out(await post("/v1/context/share", args)));

  server.tool("forget", "Delete or deactivate a RetainDB Local memory by ID.", {
    memory_id: z.string(),
  }, async (args: any) => {
    const res = await fetch(`${baseUrl}/v1/memory/${encodeURIComponent(args.memory_id)}`, { method: "DELETE" });
    return out(await res.json());
  });

  await server.connect(new StdioServerTransport());
  console.error(`[retaindb-local] MCP running on stdio (${baseUrl}, project: ${project})`);
}

function installUserConfigs(target = "all") {
  const baseUrl = process.env.RETAINDB_BASE_URL || `http://localhost:${DEFAULT_PORT}`;
  const project = process.env.RETAINDB_PROJECT || DEFAULT_PROJECT;
  const targets = target === "all" ? ["codex", "claude-code"] : [target];
  const installed: string[] = [];
  for (const item of targets) {
    if (item === "codex") installed.push(installCodexConfig(baseUrl, project));
    if (item === "claude-code") installed.push(installClaudeConfig(baseUrl, project));
    if (item === "opencode") writeConnectSnippets("opencode");
  }
  console.log(JSON.stringify({ installed, note: "Backups were written next to changed config files." }, null, 2));
}

async function runHook() {
  const baseUrl = process.env.RETAINDB_BASE_URL || `http://localhost:${DEFAULT_PORT}`;
  const kind = arg("kind") || "tool_result";
  const agentId = arg("agent") || process.env.RETAINDB_AGENT_ID || "agent";
  const sessionId = arg("session") || process.env.RETAINDB_SESSION_ID || `session-${new Date().toISOString().slice(0, 10)}`;
  const summaryArg = arg("summary");
  let stdin = "";
  if (!process.stdin.isTTY) {
    for await (const chunk of process.stdin) stdin += chunk;
  }
  const summary = summaryArg || stdin.slice(0, 4000).trim() || `${agentId} ${kind}`;
  await fetch(`${baseUrl}/v1/agent-events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      project: process.env.RETAINDB_PROJECT || DEFAULT_PROJECT,
      session_id: sessionId,
      agent_id: agentId,
      event: { kind, summary, details: stdin.slice(0, 12000), timestamp: now() },
    }),
  }).catch(() => {});
}

async function runDemo() {
  const runtime = new LocalMemoryRuntime();
  const session = "demo-session-1";
  await runtime.ingestSession({
    project: "demo",
    session_id: session,
    user_id: "demo-user",
    agent_id: "codex",
    events: [
      { kind: "decision", summary: "RetainDB uses jose middleware for JWT auth in src/middleware/auth.ts", salience: "high" },
      { kind: "constraint", summary: "Prefer edge-compatible auth libraries over jsonwebtoken", salience: "medium" },
      { kind: "outcome", summary: "Rate limiting should reuse existing Hono middleware instead of adding Redis", salience: "high" },
    ],
  });
  const results = await runtime.search({ project: "demo", user_id: "demo-user", query: "how do we handle auth and rate limiting", top_k: 5 });
  console.log("RetainDB Local demo");
  console.log(`Store: ${STORE_PATH}`);
  console.log("");
  for (const result of results) {
    console.log(`${result.score.toFixed(2)} ${result.content}`);
  }
}

function percentile(values: number[], p: number) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

async function runBenchmark() {
  const runtime = new LocalMemoryRuntime();
  const project = "benchmark";
  const fixtures = [
    { q: "jose jwt auth middleware", expect: "jose middleware" },
    { q: "n+1 query dashboard batching", expect: "N+1 query" },
    { q: "rate limiting Hono middleware", expect: "Hono middleware" },
    { q: "edge-compatible auth library", expect: "edge-compatible" },
  ];
  await runtime.ingestSession({
    project,
    session_id: "bench-session-1",
    agent_id: "benchmark",
    events: [
      { kind: "decision", summary: "Auth uses jose middleware in src/middleware/auth.ts because it is edge-compatible", salience: "high" },
      { kind: "fix", summary: "N+1 query was fixed by batching project lookups before rendering dashboard rows", salience: "high" },
      { kind: "workflow", summary: "Rate limiting should reuse existing Hono middleware and avoid adding Redis locally", salience: "high" },
    ],
  });
  const latencies: number[] = [];
  let hits = 0;
  for (const fixture of fixtures) {
    const started = performance.now();
    const results = await runtime.search({ project, query: fixture.q, top_k: 5 });
    latencies.push(performance.now() - started);
    if (results.some((result) => result.content.toLowerCase().includes(fixture.expect.toLowerCase()))) hits += 1;
  }
  const report = {
    queries: fixtures.length,
    top5_hit_rate: hits / fixtures.length,
    p50_ms: Number(percentile(latencies, 50).toFixed(2)),
    p90_ms: Number(percentile(latencies, 90).toFixed(2)),
    p99_ms: Number(percentile(latencies, 99).toFixed(2)),
    max_ms: Number(Math.max(...latencies).toFixed(2)),
    embedding_provider: EMBEDDING_PROVIDER,
    retrieval: "bm25+vector+graph+rrf+rerank",
    corpus: "retaindb-local-smoke-v1",
    created_at: now(),
  };
  const report_path = writeBenchmarkReport(report);
  appendJournal("benchmark.completed", { report_path, ...report });
  Object.assign(report, { report_path });
  console.log(JSON.stringify(report, null, 2));
}

async function installEmbeddings() {
  const previous = process.env.RETAINDB_EMBEDDING_PROVIDER;
  process.env.RETAINDB_EMBEDDING_PROVIDER = "local-transformers";
  const started = performance.now();
  try {
    const vector = await transformerEmbedding("RetainDB local embedding warmup");
    const result = {
      ok: true,
      provider: "local-transformers",
      model: process.env.RETAINDB_EMBEDDING_MODEL || "Xenova/all-MiniLM-L6-v2",
      dimensions: vector.length,
      warmup_ms: Number((performance.now() - started).toFixed(2)),
      next: "Set RETAINDB_EMBEDDING_PROVIDER=local-transformers and run `retaindb reembed`.",
    };
    appendJournal("embeddings.installed", result);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    const result = {
      ok: false,
      provider: "local-transformers",
      error: error instanceof Error ? error.message : String(error),
      fallback: "hash",
      next: "Run `pnpm rebuild onnxruntime-node` or keep the default hash embeddings.",
    };
    appendJournal("embeddings.install_failed", result);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    if (previous === undefined) delete process.env.RETAINDB_EMBEDDING_PROVIDER;
    else process.env.RETAINDB_EMBEDDING_PROVIDER = previous;
  }
}

function* jsonlFiles(root: string): Generator<string> {
  if (!existsSync(root)) return;
  const stat = statSync(root);
  if (stat.isFile()) {
    if (root.endsWith(".jsonl")) yield root;
    return;
  }
  if (!stat.isDirectory()) return;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) yield* jsonlFiles(full);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) yield full;
  }
}

function textFromJsonlEntry(entry: Record<string, unknown>) {
  const message = entry.message && typeof entry.message === "object" ? entry.message as Record<string, unknown> : undefined;
  const content = message?.content ?? entry.content ?? entry.text ?? entry.prompt;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object") {
        const record = part as Record<string, unknown>;
        return typeof record.text === "string" ? record.text : "";
      }
      return "";
    }).filter(Boolean).join("\n");
  }
  return "";
}

async function importJsonl(pathArg?: string) {
  const root = resolve(pathArg || join(homedir(), ".claude", "projects"));
  const runtime = new LocalMemoryRuntime();
  let files = 0;
  let memories = 0;
  for (const file of jsonlFiles(root)) {
    files += 1;
    const sessionId = `jsonl-${createHash("sha1").update(file).digest("hex").slice(0, 12)}`;
    const lines = readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
    const messages: Message[] = [];
    const events: WorkEvent[] = [];
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        const role = String((entry.message as any)?.role || entry.role || entry.type || "event");
        const text = redactSecrets(textFromJsonlEntry(entry)).trim();
        if (text) messages.push({ role, content: text, timestamp: String(entry.timestamp || now()) });
        const toolName = String(entry.tool_name || entry.toolName || (entry.tool_use as any)?.name || "");
        if (toolName) {
          events.push({
            kind: "tool_result",
            summary: `${toolName} used during imported session`,
            details: JSON.stringify(redactUnknown(entry)).slice(0, 12000),
            toolName,
            timestamp: String(entry.timestamp || now()),
          });
        }
      } catch {
        // Skip malformed transcript lines.
      }
    }
    const result = await runtime.ingestSession({
      project: DEFAULT_PROJECT,
      session_id: sessionId,
      agent_id: "import-jsonl",
      messages,
      events,
    });
    memories += result.memories_created;
  }
  console.log(JSON.stringify({ imported: true, root, files, memories, store: STORE_PATH }, null, 2));
}

function startServer() {
  const runtime = new LocalMemoryRuntime();
  const app = createApp(runtime);
  const viewerPort = Number(process.env.RETAINDB_VIEWER_PORT || DEFAULT_PORT + 2);
  const viewer = createViewerApp(DEFAULT_PORT);
  serve({ fetch: app.fetch, port: DEFAULT_PORT });
  serve({ fetch: viewer.fetch, port: viewerPort });
  setInterval(() => {
    runtime.consolidate().catch(() => {});
  }, 60 * 60 * 1000).unref?.();
  console.log(`RetainDB Local running on http://localhost:${DEFAULT_PORT}`);
  console.log(`Viewer running on http://localhost:${viewerPort}`);
  console.log(`Store: ${STORE_PATH}`);
  console.log("MCP env: RETAINDB_BASE_URL=http://localhost:" + DEFAULT_PORT);
}

async function main() {
  const command = process.argv[2] || "start";
  if (command === "start" || command === "serve") return startServer();
  if (command === "mcp") return runMcp();
  if (command === "demo") return runDemo();
  if (command === "benchmark") return runBenchmark();
  if (command === "install-embeddings") return installEmbeddings();
  if (command === "connect") {
    const target = process.argv.slice(3).find((item) => !item.startsWith("--")) || "all";
    if (process.argv.includes("--install")) return installUserConfigs(target);
    return writeConnectSnippets(target);
  }
  if (command === "hook") return runHook();
  if (command === "import-jsonl") return importJsonl(process.argv[3]);
  if (command === "consolidate") {
    const runtime = new LocalMemoryRuntime();
    console.log(JSON.stringify(await runtime.consolidate(process.env.RETAINDB_PROJECT), null, 2));
    return;
  }
  if (command === "reembed") {
    const runtime = new LocalMemoryRuntime();
    console.log(JSON.stringify(await runtime.reembed(process.env.RETAINDB_PROJECT), null, 2));
    return;
  }
  if (command === "status") {
    const runtime = new LocalMemoryRuntime();
    console.log(JSON.stringify({ ok: true, ...runtime.snapshot(), api: `http://localhost:${DEFAULT_PORT}`, viewer: `http://localhost:${Number(process.env.RETAINDB_VIEWER_PORT || DEFAULT_PORT + 2)}` }, null, 2));
    return;
  }
  if (command === "doctor") {
    const runtime = new LocalMemoryRuntime();
    console.log(JSON.stringify({ ok: true, stats: runtime.stats(), port: DEFAULT_PORT }, null, 2));
    return;
  }
  console.log("RetainDB Local");
  console.log("");
  console.log("Usage:");
  console.log("  retaindb                 Start local memory server");
  console.log("  retaindb mcp             Run the bundled MCP bridge against local memory");
  console.log("  retaindb demo            Seed and search demo memories");
  console.log("  retaindb benchmark       Run a small local recall/latency benchmark");
  console.log("  retaindb install-embeddings  Warm local transformer embeddings and model cache");
  console.log("  retaindb connect all     Write Codex/Claude Code/OpenCode snippets");
  console.log("  retaindb connect all --install  Merge Codex/Claude Code user configs with backups");
  console.log("  retaindb hook            Capture a hook payload from stdin");
  console.log("  retaindb import-jsonl    Import Claude-style JSONL transcripts");
  console.log("  retaindb consolidate     Deduplicate and summarize local sessions");
  console.log("  retaindb reembed         Refresh vectors with the configured local embedding provider");
  console.log("  retaindb status          Print memory/session stats");
  console.log("  retaindb doctor          Print local runtime status");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
