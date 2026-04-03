import { createHash } from "crypto";
import { getFromCache, setInCache } from "./cache.js";

export interface PendingOverlayEntry {
  job_id: string;
  org_id: string;
  project_id: string;
  user_id?: string;
  session_id?: string;
  content: string;
  created_at: string;
  expires_at: string;
}

const PENDING_OVERLAY_TTL_MS = parseInt(process.env.PENDING_OVERLAY_TTL_MS || "30000", 10);
const PENDING_OVERLAY_MAX_ENTRIES = parseInt(process.env.PENDING_OVERLAY_MAX_ENTRIES || "100", 10);

function normalizeText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function tokenize(value: string): string[] {
  return normalizeText(value)
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
}

function singularize(token: string): string {
  if (token.endsWith("ies") && token.length > 4) return `${token.slice(0, -3)}y`;
  if (token.endsWith("s") && token.length > 3) return token.slice(0, -1);
  return token;
}

function scoreByQuery(entryContent: string, query: string): number {
  const contentTokens = new Set(tokenize(entryContent).map(singularize));
  if (contentTokens.size === 0) return 0;

  const queryTokens = tokenize(query).map(singularize);
  if (queryTokens.length === 0) return 0;

  let overlap = 0;
  for (const token of queryTokens) {
    if (contentTokens.has(token)) overlap += 1;
  }

  const normalizedQuery = normalizeText(query);
  const normalizedContent = normalizeText(entryContent);
  const phraseHit = normalizedContent.includes(normalizedQuery) ? 2 : 0;

  return overlap + phraseHit;
}

function hashScope(parts: Array<string | undefined>): string {
  const raw = parts.filter(Boolean).join("|");
  return createHash("sha256").update(raw).digest("hex").slice(0, 20);
}

function sessionKey(orgId: string, projectId: string, sessionId: string): string {
  return `pending_overlay:session:${hashScope([orgId, projectId, sessionId])}`;
}

function userKey(orgId: string, projectId: string, userId: string): string {
  return `pending_overlay:user:${hashScope([orgId, projectId, userId])}`;
}

function isActive(entry: PendingOverlayEntry, nowMs: number): boolean {
  return new Date(entry.expires_at).getTime() > nowMs;
}

function dedupeEntries(entries: PendingOverlayEntry[]): PendingOverlayEntry[] {
  const seen = new Set<string>();
  const unique: PendingOverlayEntry[] = [];
  for (const entry of entries) {
    const key = `${entry.job_id}:${entry.content}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(entry);
  }
  return unique;
}

async function putList(key: string, entries: PendingOverlayEntry[], ttlSeconds: number): Promise<void> {
  await setInCache(key, entries, ttlSeconds);
}

async function getList(key: string): Promise<PendingOverlayEntry[]> {
  const value = await getFromCache<PendingOverlayEntry[]>(key);
  return Array.isArray(value) ? value : [];
}

export async function addPendingOverlayEntry(args: {
  orgId: string;
  projectId: string;
  userId?: string;
  sessionId?: string;
  content: string;
  jobId: string;
  ttlMs?: number;
  createdAt?: string;
}): Promise<boolean> {
  const ttlMs = Math.max(args.ttlMs ?? PENDING_OVERLAY_TTL_MS, 1000);
  const ttlSeconds = Math.max(Math.ceil(ttlMs / 1000), 1);
  const createdAt = args.createdAt || new Date().toISOString();
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();

  const entry: PendingOverlayEntry = {
    job_id: args.jobId,
    org_id: args.orgId,
    project_id: args.projectId,
    user_id: args.userId,
    session_id: args.sessionId,
    content: args.content,
    created_at: createdAt,
    expires_at: expiresAt,
  };

  const writes: Array<Promise<void>> = [];

  if (args.sessionId) {
    const key = sessionKey(args.orgId, args.projectId, args.sessionId);
    const current = (await getList(key)).filter((item) => isActive(item, Date.now()));
    const next = dedupeEntries([entry, ...current]).slice(0, PENDING_OVERLAY_MAX_ENTRIES);
    writes.push(putList(key, next, ttlSeconds));
  }

  if (args.userId) {
    const key = userKey(args.orgId, args.projectId, args.userId);
    const current = (await getList(key)).filter((item) => isActive(item, Date.now()));
    const next = dedupeEntries([entry, ...current]).slice(0, PENDING_OVERLAY_MAX_ENTRIES);
    writes.push(putList(key, next, ttlSeconds));
  }

  if (writes.length === 0) {
    return false;
  }

  await Promise.all(writes);
  return true;
}

export async function getPendingOverlayEntries(args: {
  orgId: string;
  projectId: string;
  userId?: string;
  sessionId?: string;
  query?: string;
  limit?: number;
}): Promise<PendingOverlayEntry[]> {
  const nowMs = Date.now();
  const candidates: PendingOverlayEntry[] = [];

  if (args.sessionId) {
    const key = sessionKey(args.orgId, args.projectId, args.sessionId);
    candidates.push(...(await getList(key)));
  }
  if (args.userId) {
    const key = userKey(args.orgId, args.projectId, args.userId);
    candidates.push(...(await getList(key)));
  }

  let results = dedupeEntries(candidates).filter((item) => isActive(item, nowMs));
  if (args.query && args.query.trim().length > 0) {
    const ranked = results
      .map((item) => ({ item, score: scoreByQuery(item.content, args.query || "") }))
      .filter((row) => row.score > 0)
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return b.item.created_at.localeCompare(a.item.created_at);
      })
      .map((row) => row.item);

    // Keep immediate read-after-write visibility even when lexical overlap is weak.
    if (ranked.length > 0) {
      results = ranked;
    }
  }

  results.sort((a, b) => b.created_at.localeCompare(a.created_at));
  return results.slice(0, Math.max(args.limit ?? 10, 1));
}
