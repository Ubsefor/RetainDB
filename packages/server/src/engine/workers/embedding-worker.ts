/**
 * Embedding Worker - Background processor for async embedding jobs
 * Polls Redis queue and processes embedding jobs
 */

import { Prisma } from "@prisma/client";
import { db } from "../../db/index.js";
import { embedSingle } from "../embeddings.js";
import {
  dequeueMemoryEmbeddingJob,
  dequeueChunkEmbeddingJob,
  enqueueMemoryEmbeddingJob,
  enqueueChunkEmbeddingJob,
  EmbeddingJob,
} from "../queue.js";

const MAX_RETRIES = 3;
const POLL_INTERVAL_MS = 100;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function processMemoryJob(job: EmbeddingJob): Promise<void> {
  console.log(`[Worker] Processing memory embedding job ${job.id}`);

  const embedding = await embedSingle(job.text);
  const embeddingStr = `[${embedding.join(",")}]`;

  await db.$executeRaw(
    Prisma.sql`
      UPDATE memories
      SET
        embedding = ${embeddingStr}::vector,
        metadata = jsonb_set(
          COALESCE(metadata, '{}'::jsonb),
          '{semantic_status}',
          '"ready"'::jsonb,
          true
        )
      WHERE id = ${job.id}
    `
  );

  console.log(`[Worker] Completed memory embedding for ${job.id}`);
}

async function processChunkJob(job: EmbeddingJob): Promise<void> {
  console.log(`[Worker] Processing chunk embedding job ${job.id}`);

  const embedding = await embedSingle(job.text);
  const embeddingStr = `[${embedding.join(",")}]`;

  await db.$executeRaw(
    Prisma.sql`
      UPDATE chunks
      SET embedding = ${embeddingStr}::vector
      WHERE id = ${job.id}
    `
  );

  console.log(`[Worker] Completed chunk embedding for ${job.id}`);
}

async function requeueJob(job: EmbeddingJob, queue: "memory" | "chunk"): Promise<void> {
  const retryCount = (job.retryCount || 0) + 1;
  if (retryCount >= MAX_RETRIES) {
    console.error(`[Worker] Job ${job.id} failed after ${MAX_RETRIES} retries, dropping`);
    return;
  }

  const requeuedJob = { ...job, retryCount };
  console.log(`[Worker] Requeuing job ${job.id}, retry ${retryCount}/${MAX_RETRIES}`);

  await sleep(Math.pow(2, retryCount) * 1000);

  if (queue === "memory") {
    await enqueueMemoryEmbeddingJob(requeuedJob);
  } else {
    await enqueueChunkEmbeddingJob(requeuedJob);
  }
}

let isRunning = false;

export async function startEmbeddingWorker(): Promise<void> {
  if (isRunning) {
    console.log("[Worker] Embedding worker already running");
    return;
  }

  isRunning = true;
  console.log("[Worker] Starting embedding worker...");

  while (isRunning) {
    let job: EmbeddingJob | null = null;
    let queue: "memory" | "chunk" | null = null;

    try {
      job = await dequeueMemoryEmbeddingJob();
      queue = "memory";

      if (!job) {
        job = await dequeueChunkEmbeddingJob();
        queue = "chunk";
      }

      if (!job) {
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      if (queue === "memory") {
        await processMemoryJob(job);
      } else {
        await processChunkJob(job);
      }
    } catch (error: any) {
      console.error(`[Worker] Error processing job:`, error.message);
      if (job && queue) {
        await requeueJob(job, queue);
      }
    }
  }
}

export function stopEmbeddingWorker(): void {
  isRunning = false;
  console.log("[Worker] Stopping embedding worker...");
}
