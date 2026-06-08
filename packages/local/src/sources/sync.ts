import { randomUUID } from "node:crypto";
import type { IngestedDocument, Source, SourceType, SyncResult } from "./types.js";
import { getConnector, listConnectorTypes } from "../connectors/types.js";

export type IngestFn = (input: {
  content: string;
  memory_type?: string;
  user_id?: string;
  session_id?: string;
  agent_id?: string;
  task_id?: string;
  importance?: number;
  confidence?: number;
  metadata?: Record<string, unknown>;
}) => Promise<{ id: string; active: boolean }>;

export type ProgressFn = (p: { stage: string; current: number; total: number; message: string }) => void;

export function newSourceId(): string {
  return `src_${randomUUID()}`;
}

export function describeConnectors(): Array<{ type: SourceType; requiresAuth: boolean; description: string }> {
  // Importing this lazy-evaluates the registry, so we re-import types & map them via getConnector.
  // The list may be empty if ensureConnectorsRegistered has not been called yet by the caller.
  return listConnectorTypes()
    .map((type) => {
      const c = getConnector(type);
      if (!c) return null;
      return { type: c.type, requiresAuth: c.requiresAuth, description: c.describe() };
    })
    .filter((x): x is { type: SourceType; requiresAuth: boolean; description: string } => x !== null);
}

export async function runSourceSync(input: {
  source: Source;
  ingest: IngestFn;
  onProgress?: ProgressFn;
  signal?: AbortSignal;
  maxDocuments?: number;
}): Promise<SyncResult> {
  const { source, ingest, onProgress, signal } = input;
  const maxDocuments = input.maxDocuments ?? 500;
  const startedAt = Date.now();
  const errors: string[] = [];
  const citations: Array<{ id: string; title: string }> = [];

  const provider = getConnector(source.type);
  if (!provider) {
    throw new Error(`Unknown source type: ${source.type}`);
  }
  const validation = provider.validateConfig(source.config);
  if (!validation.ok) {
    throw new Error(`Invalid config: ${validation.error}`);
  }

  onProgress?.({ stage: "fetching", current: 0, total: 0, message: `Sync ${source.id} (${source.type})` });
  let docs: IngestedDocument[] = [];
  try {
    docs = await provider.sync({ source, project: source.project, signal, onProgress });
  } catch (err: any) {
    errors.push(String(err?.message || err));
    onProgress?.({ stage: "done", current: 0, total: 0, message: `Connector error: ${err?.message || err}` });
    return {
      documents_indexed: 0,
      memories_created: 0,
      errors,
      truncated: false,
      duration_ms: Date.now() - startedAt,
      citations,
    };
  }

  const truncated = docs.length > maxDocuments;
  if (truncated) docs = docs.slice(0, maxDocuments);

  let memoriesCreated = 0;
  for (let i = 0; i < docs.length; i++) {
    if (signal?.aborted) break;
    const d = docs[i];
    onProgress?.({ stage: "indexing", current: i + 1, total: docs.length, message: d.title });
    try {
      const stored = await ingest({
        content: d.content,
        memory_type: d.source_type,
        importance: 0.7,
        confidence: 0.8,
        metadata: {
          source_id: source.id,
          source_type: d.source_type,
          source_title: d.title,
          external_id: d.external_id,
          citation: { id: d.external_id, title: d.title },
          ...d.metadata,
        },
      });
      if (stored.active) {
        memoriesCreated++;
        citations.push({ id: stored.id, title: d.title });
      }
    } catch (err: any) {
      errors.push(`[${d.external_id}] ${err?.message || err}`);
    }
  }

  onProgress?.({
    stage: "done",
    current: docs.length,
    total: docs.length,
    message: `Indexed ${memoriesCreated} memories from ${docs.length} documents`,
  });

  return {
    documents_indexed: docs.length,
    memories_created: memoriesCreated,
    errors,
    truncated,
    duration_ms: Date.now() - startedAt,
    citations,
  };
}
