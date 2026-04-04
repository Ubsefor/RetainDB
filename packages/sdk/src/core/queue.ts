import { nowIso, randomId, stableHash } from "./utils.js";

export interface QueuedWrite {
  eventId: string;
  project: string;
  userId?: string;
  sessionId?: string;
  payload: {
    content: string;
    memory_type?: string;
    user_id?: string;
    session_id?: string;
    agent_id?: string;
    task_id?: string;
    importance?: number;
    confidence?: number;
    metadata?: Record<string, unknown>;
    document_date?: string;
    event_date?: string;
  };
  createdAt: string;
}

export interface QueueStore {
  load(): Promise<QueuedWrite[]>;
  save(items: QueuedWrite[]): Promise<void>;
}

export class InMemoryQueueStore implements QueueStore {
  private items: QueuedWrite[] = [];

  async load(): Promise<QueuedWrite[]> {
    return [...this.items];
  }

  async save(items: QueuedWrite[]): Promise<void> {
    this.items = [...items];
  }
}

export interface WriteQueueStatus {
  queued: number;
  flushing: boolean;
  lastFlushAt?: string;
  lastFlushCount: number;
}

type FlushHandler = (items: QueuedWrite[]) => Promise<void>;

export class WriteQueue {
  private readonly flushHandler: FlushHandler;
  private readonly store: QueueStore;
  private readonly maxBatchSize: number;
  private readonly flushIntervalMs: number;
  private readonly maxAttempts: number;
  private readonly queue: QueuedWrite[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;
  private lastFlushAt?: string;
  private lastFlushCount = 0;

  constructor(args: {
    flushHandler: FlushHandler;
    store?: QueueStore;
    maxBatchSize?: number;
    flushIntervalMs?: number;
    maxAttempts?: number;
  }) {
    this.flushHandler = args.flushHandler;
    this.store = args.store || new InMemoryQueueStore();
    this.maxBatchSize = Math.max(1, args.maxBatchSize ?? 50);
    this.flushIntervalMs = Math.max(10, args.flushIntervalMs ?? 100);
    this.maxAttempts = Math.max(1, args.maxAttempts ?? 2);
  }

  async start(): Promise<void> {
    const pending = await this.store.load();
    if (pending.length > 0) {
      this.queue.push(...pending);
    }
    if (!this.flushTimer) {
      this.flushTimer = setInterval(() => {
        void this.flush();
      }, this.flushIntervalMs);
      const timer = this.flushTimer as ReturnType<typeof setInterval> & { unref?: () => void };
      if (typeof timer.unref === "function") {
        timer.unref();
      }
    }
    this.bindProcessHooks();
  }

  async stop(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
  }

  status(): WriteQueueStatus {
    return {
      queued: this.queue.length,
      flushing: this.flushing,
      lastFlushAt: this.lastFlushAt,
      lastFlushCount: this.lastFlushCount,
    };
  }

  async enqueue(input: Omit<QueuedWrite, "eventId" | "createdAt"> & { eventId?: string }): Promise<QueuedWrite> {
    const eventId = input.eventId || this.makeEventId(input);
    const item: QueuedWrite = {
      ...input,
      eventId,
      createdAt: nowIso(),
    };
    this.queue.push(item);
    await this.store.save(this.queue);
    if (this.queue.length >= this.maxBatchSize) {
      void this.flush();
    }
    return item;
  }

  async flush(): Promise<void> {
    if (this.flushing || this.queue.length === 0) return;
    this.flushing = true;
    try {
      while (this.queue.length > 0) {
        const batch = this.queue.slice(0, this.maxBatchSize);
        let done = false;
        let error: unknown = null;
        for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
          try {
            await this.flushHandler(batch);
            done = true;
            break;
          } catch (err) {
            error = err;
            await new Promise((resolve) => setTimeout(resolve, (attempt + 1) * 180));
          }
        }
        if (!done) {
          throw error instanceof Error ? error : new Error("Queue flush failed");
        }
        this.queue.splice(0, batch.length);
        this.lastFlushAt = nowIso();
        this.lastFlushCount = batch.length;
        await this.store.save(this.queue);
      }
    } finally {
      this.flushing = false;
    }
  }

  private makeEventId(input: Omit<QueuedWrite, "eventId" | "createdAt">): string {
    const source = JSON.stringify({
      project: input.project,
      userId: input.userId || "",
      sessionId: input.sessionId || "",
      payload: input.payload,
    });
    return `evt_${stableHash(source)}`;
  }

  private bindProcessHooks(): void {
    if (typeof process === "undefined") return;
    const proc = process as NodeJS.Process;
    const flushOnExit = () => {
      void this.flush();
    };
    proc.once("beforeExit", flushOnExit);
    proc.once("SIGINT", flushOnExit);
    proc.once("SIGTERM", flushOnExit);
  }
}

export function createStorageQueueStore(
  key = "whisper_sdk_queue"
): QueueStore {
  const getStorage = (): { getItem: (name: string) => string | null; setItem: (name: string, value: string) => void } | null => {
    const maybeStorage = (globalThis as Record<string, unknown>).localStorage;
    if (!maybeStorage || typeof maybeStorage !== "object") return null;
    const candidate = maybeStorage as { getItem?: unknown; setItem?: unknown };
    if (typeof candidate.getItem !== "function" || typeof candidate.setItem !== "function") {
      return null;
    }
    return {
      getItem: candidate.getItem as (name: string) => string | null,
      setItem: candidate.setItem as (name: string, value: string) => void,
    };
  };

  return {
    async load(): Promise<QueuedWrite[]> {
      const storage = getStorage();
      if (!storage) return [];
      const raw = storage.getItem(key);
      if (!raw) return [];
      try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed as QueuedWrite[] : [];
      } catch {
        return [];
      }
    },
    async save(items: QueuedWrite[]): Promise<void> {
      const storage = getStorage();
      if (!storage) return;
      storage.setItem(key, JSON.stringify(items));
    },
  };
}

export function createFileQueueStore(filePath: string): QueueStore {
  return {
    async load(): Promise<QueuedWrite[]> {
      if (typeof process === "undefined") return [];
      const fs = await import("node:fs/promises");
      try {
        const raw = await fs.readFile(filePath, "utf8");
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed as QueuedWrite[] : [];
      } catch (error) {
        const nodeError = error as NodeJS.ErrnoException;
        if (nodeError?.code === "ENOENT") {
          return [];
        }
        return [];
      }
    },
    async save(items: QueuedWrite[]): Promise<void> {
      if (typeof process === "undefined") return;
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      const dir = path.dirname(filePath);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(filePath, JSON.stringify(items), "utf8");
    },
  };
}
