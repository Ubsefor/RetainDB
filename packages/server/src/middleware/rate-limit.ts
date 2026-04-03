import { Context, Next } from "hono";
import { AuthContext } from "./auth.js";
import { getRedisClient } from "../engine/cache.js";

const PLAN_RATE_LIMITS: Record<string, number> = {
  FREE: 10,
  PAY_AS_YOU_GO: 30,
  PRO: 60,
  SCALE: 120,
  ENTERPRISE: 1000,
};

// ── In-memory fallback (used when Redis is unavailable) ──────────────────────

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const memStore = new Map<string, RateLimitEntry>();
const MAX_STORE_SIZE = 10000;

const cleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of memStore.entries()) {
    if (entry.resetAt < now) memStore.delete(key);
  }
  if (memStore.size > MAX_STORE_SIZE) {
    // evict oldest half
    const sorted = Array.from(memStore.entries()).sort((a, b) => a[1].resetAt - b[1].resetAt);
    for (const [k] of sorted.slice(0, MAX_STORE_SIZE / 2)) memStore.delete(k);
  }
}, 60_000);
// Allow the interval to be GC'd when process exits
if (cleanupInterval.unref) cleanupInterval.unref();

export function stopCleanup() {
  clearInterval(cleanupInterval);
}

function checkRateLimitMemory(key: string, maxRequests: number, windowMs: number): boolean {
  const now = Date.now();
  const entry = memStore.get(key);
  if (!entry || entry.resetAt < now) {
    memStore.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (entry.count >= maxRequests) return false;
  entry.count++;
  return true;
}

// ── Redis-backed rate limiter (fixed-window INCR strategy) ───────────────────

async function checkRateLimit(key: string, maxRequests: number, windowMs: number): Promise<boolean> {
  const rc = getRedisClient();
  if (rc) {
    try {
      // Key per window slot — auto-expires one window after creation
      const slot = Math.floor(Date.now() / windowMs);
      const redisKey = `rl:${key}:${slot}`;
      const count = await rc.incr(redisKey);
      if (count === 1) {
        // Set expiry slightly longer than the window so the key outlives the slot
        await rc.expire(redisKey, Math.ceil(windowMs / 1000) + 2);
      }
      return count <= maxRequests;
    } catch {
      // Redis error — fall through to in-memory
    }
  }
  return checkRateLimitMemory(key, maxRequests, windowMs);
}

// ── Extract real client IP (first entry in X-Forwarded-For only) ─────────────

function extractClientIp(c: Context): string {
  const xff = c.req.header("x-forwarded-for");
  if (xff) {
    // Take only the first (leftmost) IP — added by the first trusted proxy
    const first = xff.split(",")[0].trim();
    if (first) return first;
  }
  return c.req.header("x-real-ip") || "unknown";
}

// ── Middleware factory ────────────────────────────────────────────────────────

export interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
  keyPrefix?: string;
}

export function rateLimitMiddleware(config: RateLimitConfig) {
  return async (c: Context, next: Next) => {
    if (!config) { await next(); return; }

    const auth = c.get("auth") as AuthContext | undefined;

    if (!auth) {
      const ip = extractClientIp(c);
      const key = `${config.keyPrefix || "global"}:ip:${ip}`;
      const allowed = await checkRateLimit(key, Math.max(1, Math.floor((config.maxRequests || 100) / 10)), config.windowMs || 60_000);
      if (!allowed) {
        return c.json({ error: "Rate limit exceeded. Please authenticate or try again later.", code: "RATE_LIMIT_EXCEEDED" }, 429);
      }
    } else {
      const key = `${config.keyPrefix || "global"}:org:${auth.orgId}`;
      const allowed = await checkRateLimit(key, config.maxRequests || 100, config.windowMs || 60_000);
      if (!allowed) {
        return c.json({ error: "Rate limit exceeded. Please try again later.", code: "RATE_LIMIT_EXCEEDED" }, 429);
      }
    }

    await next();
  };
}

// ── Preset configs ────────────────────────────────────────────────────────────

export const RateLimits = {
  query:    { windowMs: 60_000, maxRequests: 2000, keyPrefix: "query" },
  ingest:   { windowMs: 60_000, maxRequests: 500,  keyPrefix: "ingest" },
  sync:     { windowMs: 60_000, maxRequests: 100,  keyPrefix: "sync" },
  general:  { windowMs: 60_000, maxRequests: 5000, keyPrefix: "general" },
  memory:   { windowMs: 60_000, maxRequests: 1000, keyPrefix: "memory" },
  mutation: { windowMs: 60_000, maxRequests: 200,  keyPrefix: "mutation" },
};
