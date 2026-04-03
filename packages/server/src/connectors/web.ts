import * as cheerio from "cheerio";
import { ingestDocument } from "../engine/ingest.js";
import { generateSourceProfile } from "../engine/source-extraction.js";
import { extractStructuredHtml } from "./html-structure.js";

// ── User-Agent rotation ────────────────────────────────────────────────────────
const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0",
];

function pickUA(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// ── Fetch with retry + backoff ──────────────────────────────────────────────────
async function fetchWithRetry(
  url: string,
  timeoutMs = 25000,
  maxAttempts = 3
): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": pickUA(),
          Accept: "text/html,application/xhtml+xml,*/*;q=0.9",
          "Accept-Language": "en-US,en;q=0.9",
          "Cache-Control": "no-cache",
        },
        redirect: "follow",
        signal: controller.signal,
      });
      clearTimeout(timer);

      // Rate-limited or temporarily unavailable — respect Retry-After
      if (res.status === 429 || res.status === 503) {
        const retryAfterRaw = res.headers.get("retry-after");
        const delay =
          retryAfterRaw && !isNaN(Number(retryAfterRaw))
            ? Number(retryAfterRaw) * 1000
            : Math.min(2 ** attempt * 1500, 10000);
        await sleep(delay);
        continue;
      }

      return res;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (attempt < maxAttempts - 1) await sleep(2 ** attempt * 1000);
    }
  }
  throw lastErr ?? new Error(`Failed to fetch ${url}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Sitemap discovery ──────────────────────────────────────────────────────────
async function discoverSitemapUrls(rootUrl: string, maxUrls = 200): Promise<string[]> {
  const candidates = [
    new URL("/sitemap.xml", rootUrl).href,
    new URL("/sitemap_index.xml", rootUrl).href,
    new URL("/sitemap-index.xml", rootUrl).href,
  ];
  const urls: string[] = [];

  for (const candidate of candidates) {
    try {
      const res = await fetchWithRetry(candidate, 10000, 2);
      if (!res.ok) continue;
      const ct = res.headers.get("content-type") || "";
      if (!ct.includes("xml") && !ct.includes("text")) continue;
      const xml = await res.text();

      // Extract <loc> tags
      const matches = xml.match(/<loc>([^<]+)<\/loc>/g) || [];
      for (const m of matches) {
        const u = m.replace(/<\/?loc>/g, "").trim();
        if (u.startsWith("http")) urls.push(u);
        if (urls.length >= maxUrls) break;
      }

      if (urls.length > 0) break; // Found a valid sitemap
    } catch {
      // Silently skip missing sitemaps
    }
  }

  return urls;
}

// ── Concurrency limiter ────────────────────────────────────────────────────────
class Semaphore {
  private queue: (() => void)[] = [];
  constructor(private permits: number) {}

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return;
    }
    return new Promise((resolve) => {
      this.queue.push(() => {
        this.permits--;
        resolve();
      });
    });
  }

  release(): void {
    this.permits++;
    const next = this.queue.shift();
    if (next) next();
  }
}

// ── Link extraction ────────────────────────────────────────────────────────────
function extractLinks(html: string, pageUrl: string, baseHostname: string): string[] {
  const $ = cheerio.load(html);
  const links: string[] = [];
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:") || href.startsWith("javascript:")) return;
    try {
      const abs = new URL(href, pageUrl).href;
      if (new URL(abs).hostname === baseHostname) links.push(abs);
    } catch {
      // ignore invalid hrefs
    }
  });
  return [...new Set(links)];
}

// ── Main config ────────────────────────────────────────────────────────────────
export interface WebConfig {
  url: string;
  selector?: string;
  maxPages?: number;
  followLinks?: boolean;
  maxDepth?: number;
  minContentLength?: number;
  concurrency?: number;
  useSitemap?: boolean;
  includePaths?: string[];
  excludePaths?: string[];
}

export async function syncWeb(
  sourceId: string,
  projectId: string,
  config: WebConfig
): Promise<{ pagesIndexed: number; totalUrls: number; errors: string[] }> {
  const {
    url,
    selector,
    maxPages = 100,
    followLinks = true,
    maxDepth = 2,
    minContentLength = 50,
    concurrency = 4,
    useSitemap = true,
    includePaths,
    excludePaths,
  } = config;

  const visited = new Set<string>();
  const errors: string[] = [];
  let indexed = 0;
  const sem = new Semaphore(concurrency);

  let baseHostname: string;
  try {
    baseHostname = new URL(url).hostname;
  } catch {
    return { pagesIndexed: 0, totalUrls: 0, errors: [`Invalid URL: ${url}`] };
  }

  // Path filters
  function isPathAllowed(pageUrl: string): boolean {
    let pathname: string;
    try {
      pathname = new URL(pageUrl).pathname;
    } catch {
      return false;
    }
    if (includePaths && includePaths.length > 0) {
      if (!includePaths.some((p) => pathname.startsWith(p))) return false;
    }
    if (excludePaths && excludePaths.length > 0) {
      if (excludePaths.some((p) => pathname.startsWith(p))) return false;
    }
    return true;
  }

  async function crawlPage(pageUrl: string, depth: number): Promise<string[]> {
    if (!isPathAllowed(pageUrl)) return [];
    await sem.acquire();
    try {
      let res: Response;
      try {
        res = await fetchWithRetry(pageUrl);
      } catch (err: any) {
        errors.push(`${pageUrl}: ${err.message}`);
        return [];
      }

      if (!res.ok) {
        errors.push(`${pageUrl}: HTTP ${res.status}`);
        return [];
      }

      const ct = res.headers.get("content-type") || "";
      if (!ct.includes("text/html") && !ct.includes("text/plain")) return [];

      const html = await res.text();
      const structured = extractStructuredHtml(html, pageUrl, selector);
      const content = structured.content;

      if (!content || content.length < minContentLength) return [];

      const cleaned = content.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
      if (cleaned.length < minContentLength) return [];

      try {
        await ingestDocument({
          sourceId,
          projectId,
          externalId: pageUrl,
          title: structured.title,
          content: cleaned,
          metadata: {
            ...structured.metadata,
            depth,
            design: structured.design,
            structuredDataTypes: structured.structuredData.map((d) => d["@type"]).filter(Boolean),
          },
          sourceType: "web",
          ingestionProfile: "web_docs",
        });
        indexed++;
      } catch (err: any) {
        errors.push(`${pageUrl}: ingest error — ${err.message}`);
      }

      if (followLinks && depth < maxDepth) {
        return extractLinks(html, pageUrl, baseHostname);
      }
      return [];
    } finally {
      sem.release();
    }
  }

  // BFS queue
  const queue: Array<{ url: string; depth: number }> = [];

  // Seed from sitemap if enabled
  if (useSitemap) {
    const sitemapUrls = await discoverSitemapUrls(url, maxPages);
    for (const u of sitemapUrls) {
      if (!visited.has(u) && isPathAllowed(u)) {
        visited.add(u);
        queue.push({ url: u, depth: 1 });
      }
    }
  }

  // Always start with the seed URL at depth 0
  visited.add(url);
  queue.unshift({ url, depth: 0 });

  const inFlight = new Set<Promise<void>>();

  async function drainQueue() {
    while (queue.length > 0 || inFlight.size > 0) {
      while (queue.length > 0 && visited.size < maxPages + inFlight.size) {
        const task = queue.shift()!;
        const p: Promise<void> = crawlPage(task.url, task.depth).then((links) => {
          inFlight.delete(p);
          if (followLinks && task.depth < maxDepth) {
            for (const link of links) {
              if (!visited.has(link) && visited.size < maxPages) {
                visited.add(link);
                queue.push({ url: link, depth: task.depth + 1 });
              }
            }
          }
        });
        inFlight.add(p);
      }
      if (inFlight.size > 0) {
        await Promise.race(inFlight);
      } else {
        break;
      }
    }
  }

  await drainQueue();

  if (indexed > 0) {
    generateSourceProfile(sourceId, projectId, { sourceType: "web", rootUrl: url }).catch(() => {});
  }

  return {
    pagesIndexed: indexed,
    totalUrls: visited.size,
    errors: errors.slice(0, 20),
  };
}
