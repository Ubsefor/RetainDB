import type { RetainDBClient } from "../whisper.js";
import { nowIso, stableHash } from "../core/utils.js";

export interface LangGraphCheckpointConfig {
  configurable: {
    thread_id: string;
    checkpoint_ns?: string;
    checkpoint_id?: string;
  };
}

export interface LangGraphCheckpointTuple {
  config: LangGraphCheckpointConfig;
  checkpoint: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  parent_config?: LangGraphCheckpointConfig | null;
}

export interface LangGraphCheckpointRecord {
  tuple: LangGraphCheckpointTuple;
  memoryId?: string;
  createdAt?: string;
  updatedAt?: string;
  score?: number;
}

export interface LangGraphCheckpointListOptions {
  limit?: number;
  before?: { checkpointId?: string; updatedAt?: string };
  sort?: "asc" | "desc";
  filter?: {
    checkpointNs?: string;
    metadata?: Record<string, unknown>;
  };
}

export interface LangGraphCheckpointSearchOptions {
  threadId: string;
  query: string;
  checkpointNs?: string;
  topK?: number;
  includePending?: boolean;
  profile?: "fast" | "balanced" | "quality";
}

export interface LangGraphCheckpointAdapterOptions {
  project?: string;
  userIdPrefix?: string;
  defaultCheckpointNs?: string;
}

type MemoryRow = Record<string, unknown>;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function isTupleLike(value: unknown): value is LangGraphCheckpointTuple {
  if (!value || typeof value !== "object") return false;
  const tuple = value as Record<string, unknown>;
  const config = asRecord(tuple.config);
  const configurable = asRecord(config.configurable);
  return Boolean(
    typeof configurable.thread_id === "string" &&
    tuple.checkpoint &&
    typeof tuple.checkpoint === "object"
  );
}

function tupleTimestamp(tuple: LangGraphCheckpointTuple, fallback?: string): number {
  const checkpoint = asRecord(tuple.checkpoint);
  const metadata = asRecord(tuple.metadata);
  const sources = [
    checkpoint.updatedAt,
    checkpoint.updated_at,
    checkpoint.ts,
    checkpoint.timestamp,
    metadata.updatedAt,
    metadata.updated_at,
    metadata.ts,
    metadata.timestamp,
    fallback,
  ];
  for (const source of sources) {
    const parsed = source ? new Date(String(source)).getTime() : Number.NaN;
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }
  return 0;
}

function metadataMatches(
  target: Record<string, unknown> | undefined,
  filter: Record<string, unknown> | undefined,
): boolean {
  if (!filter || Object.keys(filter).length === 0) return true;
  const value = target || {};
  return Object.entries(filter).every(([key, expected]) => {
    if (!(key in value)) return false;
    return JSON.stringify(value[key]) === JSON.stringify(expected);
  });
}

/**
 * LangGraph checkpoint adapter over RetainDB memory APIs.
 * Phase 5a: get/put/list.
 * Phase 5b: checkpoint_ns fidelity, richer list/search filtering, schema-hard parsing.
 */
export class LangGraphCheckpointAdapter {
  private readonly localByKey = new Map<string, LangGraphCheckpointRecord>();
  private readonly localByThread = new Map<string, Set<string>>();
  private readonly options: LangGraphCheckpointAdapterOptions;

  constructor(
    private readonly client: RetainDBClient,
    options: LangGraphCheckpointAdapterOptions = {},
  ) {
    this.options = options;
  }

  private getUserId(threadId: string): string {
    const prefix = this.options.userIdPrefix || "langgraph-thread";
    return `${prefix}:${threadId}`;
  }

  private resolveCheckpointNs(config: LangGraphCheckpointConfig): string {
    return config.configurable.checkpoint_ns || this.options.defaultCheckpointNs || "default";
  }

  private makeLocalKey(threadId: string, checkpointNs: string, checkpointId: string): string {
    return `${threadId}:${checkpointNs}:${checkpointId}`;
  }

  private normalizeTuple(tuple: LangGraphCheckpointTuple): LangGraphCheckpointTuple {
    const config = asRecord(tuple.config);
    const configurable = asRecord(config.configurable);
    const threadId = text(configurable.thread_id) || "";
    const checkpointNs = text(configurable.checkpoint_ns) || this.options.defaultCheckpointNs || "default";
    const checkpointId = text(configurable.checkpoint_id) || "";

    return {
      config: {
        configurable: {
          thread_id: threadId,
          checkpoint_ns: checkpointNs,
          checkpoint_id: checkpointId || undefined,
        },
      },
      checkpoint: asRecord(tuple.checkpoint),
      metadata: asRecord(tuple.metadata),
      parent_config: tuple.parent_config ? {
        configurable: {
          thread_id: text(tuple.parent_config.configurable.thread_id) || "",
          checkpoint_ns: text(tuple.parent_config.configurable.checkpoint_ns) || checkpointNs,
          checkpoint_id: text(tuple.parent_config.configurable.checkpoint_id),
        },
      } : null,
    };
  }

  private parseCheckpointTupleFromRow(row: MemoryRow): LangGraphCheckpointRecord | null {
    const rowMetadata = asRecord(row.metadata);
    const marker = rowMetadata.langgraph_checkpoint === true;
    const rawContent = text(row.content) || "";
    if (!rawContent) return null;

    try {
      const parsed = JSON.parse(rawContent) as unknown;
      let tuple: LangGraphCheckpointTuple | null = null;

      if (isTupleLike(parsed)) {
        tuple = this.normalizeTuple(parsed);
      } else {
        const wrapped = asRecord(parsed);
        if (isTupleLike(wrapped.tuple)) {
          tuple = this.normalizeTuple(wrapped.tuple);
        }
      }

      if (!tuple) return null;
      const config = tuple.config.configurable;
      if (!config.thread_id) return null;
      if (!config.checkpoint_id) return null;
      if (!marker && rowMetadata.checkpoint_id !== config.checkpoint_id) {
        return null;
      }

      return {
        tuple,
        memoryId: text(row.id),
        createdAt: text(row.createdAt) || text(row.created_at),
        updatedAt: text(row.updatedAt) || text(row.updated_at),
      };
    } catch {
      return null;
    }
  }

  private upsertLocal(record: LangGraphCheckpointRecord): void {
    const cfg = record.tuple.config.configurable;
    const key = this.makeLocalKey(cfg.thread_id, cfg.checkpoint_ns || "default", cfg.checkpoint_id || "");
    this.localByKey.set(key, record);
    if (!this.localByThread.has(cfg.thread_id)) {
      this.localByThread.set(cfg.thread_id, new Set());
    }
    this.localByThread.get(cfg.thread_id)!.add(key);
  }

  private mergeWithLocal(records: LangGraphCheckpointRecord[], threadId: string): LangGraphCheckpointRecord[] {
    const merged = new Map<string, LangGraphCheckpointRecord>();
    for (const record of records) {
      const cfg = record.tuple.config.configurable;
      const key = this.makeLocalKey(cfg.thread_id, cfg.checkpoint_ns || "default", cfg.checkpoint_id || "");
      merged.set(key, record);
    }
    const localKeys = this.localByThread.get(threadId);
    if (localKeys) {
      for (const key of localKeys) {
        const local = this.localByKey.get(key);
        if (local) {
          merged.set(key, local);
        }
      }
    }
    return Array.from(merged.values());
  }

  private applyListFilters(
    records: LangGraphCheckpointRecord[],
    options?: LangGraphCheckpointListOptions,
  ): LangGraphCheckpointRecord[] {
    let filtered = records;

    if (options?.filter?.checkpointNs) {
      filtered = filtered.filter(
        (record) => (record.tuple.config.configurable.checkpoint_ns || "default") === options.filter!.checkpointNs
      );
    }

    if (options?.filter?.metadata) {
      filtered = filtered.filter((record) => metadataMatches(record.tuple.metadata, options.filter!.metadata));
    }

    if (options?.before?.checkpointId) {
      const beforeId = options.before.checkpointId;
      filtered = filtered.filter(
        (record) => record.tuple.config.configurable.checkpoint_id !== beforeId
      );
    }

    if (options?.before?.updatedAt) {
      const cutoff = new Date(options.before.updatedAt).getTime();
      if (!Number.isNaN(cutoff)) {
        filtered = filtered.filter((record) => {
          const value = tupleTimestamp(record.tuple, record.updatedAt || record.createdAt);
          return value < cutoff;
        });
      }
    }

    const direction = options?.sort || "desc";
    filtered.sort((a, b) => {
      const ta = tupleTimestamp(a.tuple, a.updatedAt || a.createdAt);
      const tb = tupleTimestamp(b.tuple, b.updatedAt || b.createdAt);
      return direction === "asc" ? ta - tb : tb - ta;
    });

    if (options?.limit && options.limit > 0) {
      return filtered.slice(0, options.limit);
    }
    return filtered;
  }

  private async fetchThreadRecords(threadId: string): Promise<LangGraphCheckpointRecord[]> {
    const profile = await this.client.memory.getUserProfile({
      project: this.options.project,
      user_id: this.getUserId(threadId),
      include_pending: true,
    });

    const parsed = (profile.memories || [])
      .map((row) => this.parseCheckpointTupleFromRow(row))
      .filter((value): value is LangGraphCheckpointRecord => value !== null)
      .filter((record) => record.tuple.config.configurable.thread_id === threadId);

    const merged = this.mergeWithLocal(parsed, threadId);
    for (const record of merged) {
      this.upsertLocal(record);
    }
    return merged;
  }

  async get(config: LangGraphCheckpointConfig): Promise<LangGraphCheckpointTuple | undefined> {
    const threadId = config.configurable.thread_id;
    const checkpointNs = this.resolveCheckpointNs(config);
    const checkpointId = config.configurable.checkpoint_id;

    if (checkpointId) {
      const local = this.localByKey.get(this.makeLocalKey(threadId, checkpointNs, checkpointId));
      if (local) return local.tuple;
    }

    const records = await this.fetchThreadRecords(threadId);
    const scoped = records.filter((record) => {
      const cfg = record.tuple.config.configurable;
      if ((cfg.checkpoint_ns || "default") !== checkpointNs) return false;
      if (!checkpointId) return true;
      return cfg.checkpoint_id === checkpointId;
    });

    if (scoped.length === 0) return undefined;
    scoped.sort((a, b) => {
      const ta = tupleTimestamp(a.tuple, a.updatedAt || a.createdAt);
      const tb = tupleTimestamp(b.tuple, b.updatedAt || b.createdAt);
      return tb - ta;
    });
    return scoped[0].tuple;
  }

  async put(
    config: LangGraphCheckpointConfig,
    checkpoint: Record<string, unknown>,
    metadata?: Record<string, unknown>,
    parentConfig?: LangGraphCheckpointConfig | null,
  ): Promise<LangGraphCheckpointConfig> {
    const threadId = config.configurable.thread_id;
    const checkpointNs = this.resolveCheckpointNs(config);
    const checkpointId =
      config.configurable.checkpoint_id ||
      text(checkpoint.id) ||
      `cp_${stableHash(JSON.stringify({
        threadId,
        checkpointNs,
        checkpoint,
        metadata: metadata || {},
        parentConfig: parentConfig || null,
      }))}`;

    const tuple: LangGraphCheckpointTuple = this.normalizeTuple({
      config: {
        configurable: {
          thread_id: threadId,
          checkpoint_ns: checkpointNs,
          checkpoint_id: checkpointId,
        },
      },
      checkpoint: {
        ...checkpoint,
        id: checkpointId,
      },
      metadata: {
        ...(metadata || {}),
        checkpoint_ns: checkpointNs,
        written_at: nowIso(),
      },
      parent_config: parentConfig ? this.normalizeTuple({
        config: parentConfig,
        checkpoint: {},
        metadata: {},
        parent_config: null,
      }).config : null,
    });

    const record: LangGraphCheckpointRecord = { tuple, updatedAt: nowIso() };
    this.upsertLocal(record);

    await this.client.memory.add({
      project: this.options.project,
      user_id: this.getUserId(threadId),
      session_id: threadId,
      memory_type: "event",
      write_mode: "async",
      content: JSON.stringify(tuple),
      metadata: {
        langgraph_checkpoint: true,
        thread_id: threadId,
        checkpoint_ns: checkpointNs,
        checkpoint_id: checkpointId,
        parent_checkpoint_id: parentConfig?.configurable.checkpoint_id,
      },
    });

    return tuple.config;
  }

  async list(
    config: LangGraphCheckpointConfig,
    options?: LangGraphCheckpointListOptions,
  ): Promise<LangGraphCheckpointTuple[]> {
    const threadId = config.configurable.thread_id;
    const checkpointNs = this.resolveCheckpointNs(config);
    const records = await this.fetchThreadRecords(threadId);
    const scoped = records.filter(
      (record) => (record.tuple.config.configurable.checkpoint_ns || "default") === checkpointNs
    );
    return this.applyListFilters(scoped, options).map((record) => record.tuple);
  }

  async search(params: LangGraphCheckpointSearchOptions): Promise<LangGraphCheckpointTuple[]> {
    const includePending = params.includePending !== false;
    const profile = params.profile || "fast";
    const checkpointNs = params.checkpointNs || this.options.defaultCheckpointNs || "default";

    const response = await this.client.memory.search({
      project: this.options.project,
      query: params.query,
      user_id: this.getUserId(params.threadId),
      session_id: params.threadId,
      top_k: params.topK || 10,
      include_pending: includePending,
      profile,
    });

    const serverHits = (response.results || [])
      .map((row) => {
        const content = text(row.memory?.content);
        if (!content) return null;
        try {
          const parsed = JSON.parse(content);
          if (!isTupleLike(parsed)) return null;
          const tuple = this.normalizeTuple(parsed);
          const ns = tuple.config.configurable.checkpoint_ns || "default";
          if (tuple.config.configurable.thread_id !== params.threadId) return null;
          if (ns !== checkpointNs) return null;
          return { tuple, score: row.similarity || 0 };
        } catch {
          return null;
        }
      })
      .filter((value): value is { tuple: LangGraphCheckpointTuple; score: number } => value !== null);

    const merged = new Map<string, { tuple: LangGraphCheckpointTuple; score: number }>();
    for (const hit of serverHits) {
      const cfg = hit.tuple.config.configurable;
      const key = this.makeLocalKey(cfg.thread_id, cfg.checkpoint_ns || "default", cfg.checkpoint_id || "");
      merged.set(key, hit);
    }

    const localKeys = this.localByThread.get(params.threadId);
    if (localKeys && includePending) {
      for (const key of localKeys) {
        const local = this.localByKey.get(key);
        if (!local) continue;
        const cfg = local.tuple.config.configurable;
        if ((cfg.checkpoint_ns || "default") !== checkpointNs) continue;
        if (!merged.has(key)) {
          merged.set(key, { tuple: local.tuple, score: 0 });
        }
      }
    }

    return Array.from(merged.values())
      .sort((a, b) => b.score - a.score)
      .map((row) => row.tuple)
      .slice(0, params.topK || 10);
  }
}

export function createLangGraphCheckpointAdapter(
  client: RetainDBClient,
  options: LangGraphCheckpointAdapterOptions = {},
): LangGraphCheckpointAdapter {
  return new LangGraphCheckpointAdapter(client, options);
}
