import { normalizeQuery, stableHash } from "./utils.js";

type CacheEntry<T> = {
  value: T;
  expiresAt: number;
  touchedAt: number;
  scopeKey: string;
};

export interface SearchCacheKeyInput {
  project: string;
  userId?: string;
  sessionId?: string;
  agentId?: string;
  taskId?: string;
  query: string;
  topK: number;
  profile: string;
  includePending: boolean;
}

export class SearchResponseCache<T = unknown> {
  private readonly ttlMs: number;
  private readonly capacity: number;
  private readonly byKey = new Map<string, CacheEntry<T>>();
  private readonly scopeIndex = new Map<string, Set<string>>();

  constructor(ttlMs = 7000, capacity = 500) {
    this.ttlMs = Math.max(1000, ttlMs);
    this.capacity = Math.max(10, capacity);
  }

  makeScopeKey(project: string, userId?: string, sessionId?: string, agentId?: string, taskId?: string): string {
    return `${project}:${userId || "_"}:${sessionId || "_"}:${agentId || "_"}:${taskId || "_"}`;
  }

  makeKey(input: SearchCacheKeyInput): string {
    const normalized = {
      project: input.project,
      userId: input.userId || "",
      sessionId: input.sessionId || "",
      agentId: input.agentId || "",
      taskId: input.taskId || "",
      query: normalizeQuery(input.query),
      topK: input.topK,
      profile: input.profile,
      includePending: input.includePending,
    };
    return `search:${stableHash(JSON.stringify(normalized))}`;
  }

  get(key: string): T | null {
    const found = this.byKey.get(key);
    if (!found) return null;
    if (found.expiresAt <= Date.now()) {
      this.deleteByKey(key);
      return null;
    }
    found.touchedAt = Date.now();
    return found.value;
  }

  set(key: string, scopeKey: string, value: T): void {
    this.byKey.set(key, {
      value,
      scopeKey,
      touchedAt: Date.now(),
      expiresAt: Date.now() + this.ttlMs,
    });

    if (!this.scopeIndex.has(scopeKey)) {
      this.scopeIndex.set(scopeKey, new Set());
    }
    this.scopeIndex.get(scopeKey)!.add(key);

    this.evictIfNeeded();
  }

  invalidateScope(scopeKey: string): number {
    const keys = this.scopeIndex.get(scopeKey);
    if (!keys || keys.size === 0) {
      return 0;
    }
    const toDelete = Array.from(keys);
    for (const key of toDelete) {
      this.deleteByKey(key);
    }
    this.scopeIndex.delete(scopeKey);
    return toDelete.length;
  }

  private evictIfNeeded(): void {
    if (this.byKey.size <= this.capacity) return;
    const ordered = Array.from(this.byKey.entries()).sort((a, b) => a[1].touchedAt - b[1].touchedAt);
    const removeCount = this.byKey.size - this.capacity;
    for (let i = 0; i < removeCount; i += 1) {
      this.deleteByKey(ordered[i][0]);
    }
  }

  private deleteByKey(key: string): void {
    const found = this.byKey.get(key);
    if (!found) return;
    this.byKey.delete(key);
    const scopeKeys = this.scopeIndex.get(found.scopeKey);
    if (!scopeKeys) return;
    scopeKeys.delete(key);
    if (scopeKeys.size === 0) {
      this.scopeIndex.delete(found.scopeKey);
    }
  }
}
