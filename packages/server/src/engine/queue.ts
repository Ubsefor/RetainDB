/**
 * Queue Module - Redis-based queue for async embedding jobs
 * Uses Upstash Redis lists (LPUSH + LPOP)
 * Must be initialized AFTER Redis is connected
 */

import { getRedisClient } from "./cache.js";

const MEMORY_EMBEDDING_QUEUE = "memory:embedding:queue";
const CHUNK_EMBEDDING_QUEUE = "chunk:embedding:queue";

export interface EmbeddingJob {
  id: string;
  text: string;
  type: "memory" | "chunk";
  projectId: string;
  orgId?: string;
  retryCount?: number;
}

function getRedis() {
  return getRedisClient();
}

async function callRedis(rc: any, methods: string[], ...args: any[]) {
  for (const method of methods) {
    const fn = rc?.[method];
    if (typeof fn === "function") {
      return await fn.apply(rc, args);
    }
  }
  throw new Error(`Redis client missing expected methods: ${methods.join(" or ")}`);
}

export async function enqueueMemoryEmbeddingJob(job: Omit<EmbeddingJob, "type">): Promise<void> {
  const rc = getRedis();
  if (!rc) {
    console.warn("[Queue] Redis not available, skipping embedding queue");
    return;
  }
  try {
    const queueJob: EmbeddingJob = { ...job, type: "memory" };
    await callRedis(rc, ["lPush", "lpush"], MEMORY_EMBEDDING_QUEUE, JSON.stringify(queueJob));
  } catch (err) {
    console.error("[Queue] Failed to enqueue memory job:", err);
  }
}

export async function enqueueChunkEmbeddingJob(job: Omit<EmbeddingJob, "type">): Promise<void> {
  const rc = getRedis();
  if (!rc) return;
  try {
    const queueJob: EmbeddingJob = { ...job, type: "chunk" };
    await callRedis(rc, ["lPush", "lpush"], CHUNK_EMBEDDING_QUEUE, JSON.stringify(queueJob));
  } catch (err) {
    console.error("[Queue] Failed to enqueue chunk job:", err);
  }
}

function safeParseJob(raw: string | null): EmbeddingJob | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as EmbeddingJob;
  } catch (err) {
    console.error("[Queue] Malformed job payload discarded:", raw.slice(0, 120), err);
    return null;
  }
}

export async function dequeueMemoryEmbeddingJob(): Promise<EmbeddingJob | null> {
  const rc = getRedis();
  if (!rc) return null;
  try {
    const raw = await callRedis(rc, ["lPop", "lpop"], MEMORY_EMBEDDING_QUEUE);
    return safeParseJob(raw);
  } catch (err) {
    console.error("[Queue] Failed to dequeue memory job:", err);
    return null;
  }
}

export async function dequeueChunkEmbeddingJob(): Promise<EmbeddingJob | null> {
  const rc = getRedis();
  if (!rc) return null;
  try {
    const raw = await callRedis(rc, ["lPop", "lpop"], CHUNK_EMBEDDING_QUEUE);
    return safeParseJob(raw);
  } catch (err) {
    console.error("[Queue] Failed to dequeue chunk job:", err);
    return null;
  }
}

export async function getQueueLength(type: "memory" | "chunk"): Promise<number> {
  const rc = getRedis();
  if (!rc) return 0;
  const queue = type === "memory" ? MEMORY_EMBEDDING_QUEUE : CHUNK_EMBEDDING_QUEUE;
  try {
    return await callRedis(rc, ["lLen", "llen"], queue);
  } catch {
    return 0;
  }
}
