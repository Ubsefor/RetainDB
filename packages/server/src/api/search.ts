/**
 * Live File Search API Routes
 * 1. POST /v1/search/files    — keyword/ripgrep search, no indexing required
 * 2. POST /v1/search/semantic — semantic vector search on raw content, no indexing required
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { spawnSync } from "child_process";
import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from "fs";
import { join, relative, extname, resolve as resolvePath } from "path";
import crypto from "crypto";
import type { AuthContext } from "../middleware/auth.js";
import { rateLimitMiddleware, RateLimits } from "../middleware/rate-limit.js";
import { embed, embedSingle } from "../engine/embeddings.js";

type Variables = { auth: AuthContext };

export const searchRoutes = new Hono<{ Variables: Variables }>();

// ── Persistent Embedding Cache ────────────────────────────────
// Survives server restarts. Each file is only ever embedded once.
// Location: EMBEDDING_CACHE_FILE env var, or .embedding-cache.json next to the process.
const EMBEDDING_CACHE_FILE = process.env.EMBEDDING_CACHE_FILE ?? ".embedding-cache.json";
const DOC_CACHE_MAX = 10_000;

// In-memory layer (hash → vector)
const docEmbeddingCache = new Map<string, number[]>();

// Load persisted cache from disk at startup (sync, fast)
function loadPersistentCache() {
  try {
    if (existsSync(EMBEDDING_CACHE_FILE)) {
      const raw = readFileSync(EMBEDDING_CACHE_FILE, "utf-8");
      const entries: Record<string, number[]> = JSON.parse(raw);
      for (const [hash, vec] of Object.entries(entries)) {
        docEmbeddingCache.set(hash, vec);
      }
      console.log(`[EmbeddingCache] Loaded ${docEmbeddingCache.size} cached embeddings from disk`);
    }
  } catch {
    console.warn("[EmbeddingCache] Could not load cache file, starting fresh");
  }
}

// Debounced disk write — batches writes to avoid hammering disk on large requests
let persistTimer: ReturnType<typeof setTimeout> | null = null;
function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      const entries: Record<string, number[]> = {};
      for (const [hash, vec] of docEmbeddingCache) entries[hash] = vec;
      writeFileSync(EMBEDDING_CACHE_FILE, JSON.stringify(entries));
    } catch (e) {
      console.warn("[EmbeddingCache] Failed to persist cache:", e);
    }
  }, 2000); // write 2s after last new embedding
}

loadPersistentCache();

// ── Result Cache ──────────────────────────────────────────────
// Identical query + identical doc-set → instant return
interface CachedResult { results: SemanticResult[]; ts: number }
const searchResultCache = new Map<string, CachedResult>();
const RESULT_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const RESULT_CACHE_MAX = 200;

function contentHash(text: string): string {
  return crypto.createHash("md5").update(text).digest("hex");
}

function getResultCacheKey(query: string, documents: Array<{ id: string; content: string }>): string {
  const docHash = crypto
    .createHash("md5")
    .update(documents.map((d) => `${d.id}:${contentHash(d.content)}`).join("|"))
    .digest("hex");
  return `${contentHash(query)}:${docHash}`;
}

/**
 * Embed texts using a two-layer cache (memory + disk).
 * Only truly new content hits the embedding model.
 * Missing embeddings are batched and sent in parallel.
 */
async function embedWithCache(texts: string[]): Promise<number[][]> {
  const result: number[][] = new Array(texts.length);
  const missing: Array<{ index: number; text: string }> = [];

  for (let i = 0; i < texts.length; i++) {
    const cached = docEmbeddingCache.get(contentHash(texts[i]));
    if (cached) {
      result[i] = cached;
    } else {
      missing.push({ index: i, text: texts[i] });
    }
  }

  if (missing.length > 0) {
    console.log(`[EmbeddingCache] ${texts.length - missing.length} hits, ${missing.length} misses — embedding now`);

    // Send all missing texts as one batch to embeddings engine.
    // In hybrid mode the engine routes large batches to OpenAI automatically.
    const BATCH_SIZE = 100;
    const batches: Array<Array<{ index: number; text: string }>> = [];
    for (let i = 0; i < missing.length; i += BATCH_SIZE) {
      batches.push(missing.slice(i, i + BATCH_SIZE));
    }

    const batchResults = await Promise.all(
      batches.map((batch) => embed(batch.map((m) => m.text)))
    );

    let hasNewEmbeddings = false;
    for (let b = 0; b < batches.length; b++) {
      for (let i = 0; i < batches[b].length; i++) {
        const { index, text } = batches[b][i];
        const embedding = batchResults[b][i];
        const hash = contentHash(text);

        if (docEmbeddingCache.size >= DOC_CACHE_MAX) {
          const firstKey = docEmbeddingCache.keys().next().value;
          if (firstKey) docEmbeddingCache.delete(firstKey);
        }
        docEmbeddingCache.set(hash, embedding);
        result[index] = embedding;
        hasNewEmbeddings = true;
      }
    }

    if (hasNewEmbeddings) schedulePersist();
  }

  return result;
}

export interface FileMatch {
  line: number;
  content: string;
  context_before: string[];
  context_after: string[];
}

export interface FileResult {
  file: string;
  matches: FileMatch[];
}

export interface SearchFilesResult {
  results: FileResult[];
  total_files: number;
  total_matches: number;
  search_path: string;
  mode: string;
  latency_ms: number;
  engine: "ripgrep" | "node";
}

// ── Helpers ──────────────────────────────────────────────────

function isRipgrepAvailable(): boolean {
  return spawnSync("rg", ["--version"], { stdio: "ignore" }).status === 0;
}

/** Only allow simple alphanumeric extensions — prevents shell metacharacter injection */
function sanitizeFileType(ft: string): string {
  if (!/^[a-zA-Z0-9]+$/.test(ft)) throw new Error(`Invalid file type: ${ft}`);
  return ft;
}

function buildGlobPattern(fileTypes?: string[]): string {
  if (!fileTypes || fileTypes.length === 0) return "";
  if (fileTypes.length === 1) return `*.${fileTypes[0]}`;
  return `*.{${fileTypes.join(",")}}`;
}

function searchWithRipgrep(params: {
  query: string;
  path: string;
  mode: "content" | "filename" | "both";
  fileTypes?: string[];
  maxResults: number;
  contextLines: number;
  caseSensitive: boolean;
}): FileResult[] {
  const { query, path, mode, fileTypes, maxResults, contextLines, caseSensitive } = params;
  const results: FileResult[] = [];

  // Build glob args as individual array elements — no shell interpolation possible
  const safeFileTypes = fileTypes?.map(sanitizeFileType);
  const globArgs: string[] = [
    "--glob", "!node_modules",
    "--glob", "!.git",
    "--glob", "!dist",
    "--glob", "!.next",
    "--glob", "!build",
    ...(safeFileTypes && safeFileTypes.length > 0
      ? ["--glob", buildGlobPattern(safeFileTypes)]
      : []),
  ];

  if (mode === "content" || mode === "both") {
    const args = [
      "--json",
      ...(caseSensitive ? [] : ["-i"]),
      `-C`, `${contextLines}`,
      `-m`, `${maxResults}`,
      "--max-filesize", "1M",
      "--no-ignore-vcs",
      "--hidden",
      ...globArgs,
      "--",   // treat next args as literals, not flags
      query,
      path,
    ];

    const proc = spawnSync("rg", args, { maxBuffer: 10 * 1024 * 1024 });
    // rg exits 1 when no matches — that's fine
    if (proc.status !== null && proc.status > 1) {
      throw new Error(`ripgrep error: ${proc.stderr?.toString()}`);
    }

    const output = (proc.stdout?.toString() ?? "").trim();
    const fileMap = new Map<string, FileMatch[]>();

    for (const line of output.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.type === "match") {
          const filePath = relative(path, entry.data.path.text);
          if (!fileMap.has(filePath)) fileMap.set(filePath, []);
          fileMap.get(filePath)!.push({
            line: entry.data.line_number,
            content: entry.data.lines.text.trimEnd(),
            context_before: [],
            context_after: [],
          });
        }
      } catch {
        // skip malformed JSON lines
      }
    }

    for (const [file, matches] of fileMap) {
      results.push({ file, matches });
    }
  }

  if (mode === "filename" || mode === "both") {
    const args = [
      "--files",
      "--no-ignore-vcs",
      "--hidden",
      ...globArgs,
      "--",
      path,
    ];

    const proc = spawnSync("rg", args, { maxBuffer: 5 * 1024 * 1024 });
    if (proc.status !== null && proc.status > 1) {
      throw new Error(`ripgrep error: ${proc.stderr?.toString()}`);
    }

    const queryLower = query.toLowerCase();
    const existingFiles = new Set(results.map(r => r.file));
    const allFiles = (proc.stdout?.toString() ?? "").split("\n").filter(Boolean);

    for (const filePath of allFiles) {
      if (results.length >= maxResults) break;
      const relPath = relative(path, filePath);
      if (!caseSensitive ? relPath.toLowerCase().includes(queryLower) : relPath.includes(query)) {
        if (!existingFiles.has(relPath)) {
          results.push({ file: relPath, matches: [] });
          existingFiles.add(relPath);
        }
      }
    }
  }

  return results;
}

function* walkDir(dir: string, fileTypes?: string[]): Generator<string> {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (["node_modules", ".git", "dist", ".next", "build"].includes(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkDir(full, fileTypes);
    } else if (entry.isFile()) {
      if (!fileTypes || fileTypes.length === 0) {
        yield full;
      } else {
        const ext = extname(entry.name).replace(".", "");
        if (fileTypes.includes(ext)) yield full;
      }
    }
  }
}

function searchWithNode(params: {
  query: string;
  path: string;
  mode: "content" | "filename" | "both";
  fileTypes?: string[];
  maxResults: number;
  contextLines: number;
  caseSensitive: boolean;
}): FileResult[] {
  const { query, path, mode, fileTypes, maxResults, contextLines, caseSensitive } = params;
  const results: FileResult[] = [];
  const regex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), caseSensitive ? "g" : "gi");

  for (const filePath of walkDir(path, fileTypes)) {
    if (results.length >= maxResults) break;
    const relPath = relative(path, filePath);

    // Filename match
    if ((mode === "filename" || mode === "both") && regex.test(relPath)) {
      const existing = results.find(r => r.file === relPath);
      if (!existing) results.push({ file: relPath, matches: [] });
      regex.lastIndex = 0;
      continue;
    }

    // Content match
    if (mode === "content" || mode === "both") {
      try {
        const stat = statSync(filePath);
        if (stat.size > 1024 * 1024) continue; // skip >1MB

        const text = readFileSync(filePath, "utf-8");
        const lines = text.split("\n");
        const matches: FileMatch[] = [];

        lines.forEach((line, i) => {
          regex.lastIndex = 0;
          if (regex.test(line)) {
            matches.push({
              line: i + 1,
              content: line.trimEnd(),
              context_before: lines.slice(Math.max(0, i - contextLines), i).map(l => l.trimEnd()),
              context_after: lines.slice(i + 1, i + 1 + contextLines).map(l => l.trimEnd()),
            });
          }
          regex.lastIndex = 0;
        });

        if (matches.length > 0) {
          const existing = results.find(r => r.file === relPath);
          if (existing) {
            existing.matches.push(...matches);
          } else {
            results.push({ file: relPath, matches });
          }
        }
      } catch {
        // skip unreadable files
      }
    }
  }

  return results;
}

// ── API Route ─────────────────────────────────────────────────

searchRoutes.post(
  "/v1/search/files",
  rateLimitMiddleware(RateLimits.query),
  zValidator(
    "json",
    z.object({
      query: z.string().min(1).max(500).describe("Search term or pattern"),
      path: z.string().optional().describe("Directory to search. Defaults to CODEBASE_PATH env or current working directory."),
      mode: z.enum(["content", "filename", "both"]).optional().default("both"),
      file_types: z.array(z.string()).optional().describe("File extensions to include e.g. ['ts', 'js', 'py']"),
      max_results: z.number().int().min(1).max(100).optional().default(20),
      context_lines: z.number().int().min(0).max(10).optional().default(2),
      case_sensitive: z.boolean().optional().default(false),
    })
  ),
  async (c) => {
    const body = c.req.valid("json");
    const startTime = Date.now();

    // Resolve search path — user-supplied path must stay within the allowed root
    const allowedRoot = resolvePath(process.env.CODEBASE_PATH || process.cwd());
    const searchPath = resolvePath(body.path || allowedRoot);

    // Reject any path that escapes the allowed root (path traversal guard)
    if (!searchPath.startsWith(allowedRoot + "/") && searchPath !== allowedRoot) {
      return c.json({ error: "Path is outside the allowed search root" }, 400);
    }

    // Verify path exists
    try {
      statSync(searchPath);
    } catch {
      return c.json({ error: `Path not found: ${searchPath}` }, 400);
    }

    const useRipgrep = isRipgrepAvailable();
    let results: FileResult[];

    try {
      if (useRipgrep) {
        results = searchWithRipgrep({
          query: body.query,
          path: searchPath,
          mode: body.mode,
          fileTypes: body.file_types,
          maxResults: body.max_results,
          contextLines: body.context_lines,
          caseSensitive: body.case_sensitive,
        });
      } else {
        results = searchWithNode({
          query: body.query,
          path: searchPath,
          mode: body.mode,
          fileTypes: body.file_types,
          maxResults: body.max_results,
          contextLines: body.context_lines,
          caseSensitive: body.case_sensitive,
        });
      }
    } catch (error: any) {
      return c.json({ error: "Search failed", details: error.message }, 500);
    }

    const totalMatches = results.reduce((sum, r) => sum + r.matches.length, 0);

    return c.json({
      results,
      total_files: results.length,
      total_matches: totalMatches,
      search_path: searchPath,
      mode: body.mode,
      latency_ms: Date.now() - startTime,
      engine: useRipgrep ? "ripgrep" : "node",
    } satisfies SearchFilesResult);
  }
);

// ── Semantic Search ───────────────────────────────────────────
// Pure in-memory vector search over provided documents.
// No database writes. No pre-indexing required.
// Designed for AI agents to semantically search a codebase on-the-fly.

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

export interface SemanticResult {
  id: string;
  score: number;
  content: string;
  snippet: string;
}

searchRoutes.post(
  "/v1/search/semantic",
  rateLimitMiddleware(RateLimits.query),
  zValidator(
    "json",
    z.object({
      query: z.string().min(1).max(1000).describe("Natural language search query"),
      documents: z.array(
        z.object({
          id: z.string().describe("File path or unique identifier"),
          content: z.string().max(4000).describe("File content or summary (trimmed to ~4000 chars)"),
        })
      ).min(1).max(500).describe("Documents to search over (send file signatures/summaries, not full files)"),
      top_k: z.number().int().min(1).max(50).optional().default(10),
      threshold: z.number().min(0).max(1).optional().default(0.2).describe("Minimum similarity score (0-1)"),
    })
  ),
  async (c) => {
    const body = c.req.valid("json");
    const startTime = Date.now();

    try {
      // ── Result cache check (fastest path) ──────────────────
      const resultKey = getResultCacheKey(body.query, body.documents);
      const cachedResult = searchResultCache.get(resultKey);
      if (cachedResult && Date.now() - cachedResult.ts < RESULT_CACHE_TTL_MS) {
        return c.json({
          results: cachedResult.results,
          total_searched: body.documents.length,
          total_returned: cachedResult.results.length,
          query: body.query,
          latency_ms: Date.now() - startTime,
          cache: "hit",
        });
      }

      // ── Embed query + documents (doc embeddings cached) ─────
      const texts = [body.query, ...body.documents.map((d) => d.content)];
      const allEmbeddings = await embedWithCache(texts);

      const queryEmbedding = allEmbeddings[0];
      const docEmbeddings = allEmbeddings.slice(1);

      // Score each document
      const scored = body.documents.map((doc, i) => ({
        id: doc.id,
        content: doc.content,
        score: cosineSimilarity(queryEmbedding, docEmbeddings[i]),
      }));

      // Sort by score descending, filter by threshold, take top K
      const results: SemanticResult[] = scored
        .filter(r => r.score >= (body.threshold ?? 0.2))
        .sort((a, b) => b.score - a.score)
        .slice(0, body.top_k)
        .map(r => ({
          id: r.id,
          score: Math.round(r.score * 1000) / 1000,
          content: r.content,
          // Extract a short snippet: first non-empty line that has substance
          snippet: r.content
            .split("\n")
            .filter(l => l.trim().length > 10)
            .slice(0, 3)
            .join(" ")
            .slice(0, 200),
        }));

      // ── Store in result cache ──────────────────────────────
      if (searchResultCache.size >= RESULT_CACHE_MAX) {
        const firstKey = searchResultCache.keys().next().value;
        if (firstKey) searchResultCache.delete(firstKey);
      }
      searchResultCache.set(resultKey, { results, ts: Date.now() });

      return c.json({
        results,
        total_searched: body.documents.length,
        total_returned: results.length,
        query: body.query,
        latency_ms: Date.now() - startTime,
        cache: "miss",
      });
    } catch (error: any) {
      console.error("[SemanticSearch] Error:", error.message);
      return c.json({ error: "Semantic search failed", details: error.message }, 500);
    }
  }
);
