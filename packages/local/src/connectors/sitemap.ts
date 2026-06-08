import type { ConnectorProvider } from "./types.js";
import { fetchWithRetry, htmlToText, titleOf } from "./fetch.js";

interface SitemapConfig {
  url: string;
  maxPages?: number;
}

interface SitemapEntry { loc: string; lastmod?: string }

function parseSitemapXml(xml: string): { entries: SitemapEntry[]; nested: string[] } {
  const entries: SitemapEntry[] = [];
  const nested: string[] = [];
  const nestedRe = /<sitemap[^>]*>\s*<loc>\s*([^<]+?)\s*<\/loc>/gi;
  let m: RegExpExecArray | null;
  while ((m = nestedRe.exec(xml)) !== null) nested.push(m[1].trim());
  const urlRe = /<url[^>]*>([\s\S]*?)<\/url>/gi;
  while ((m = urlRe.exec(xml)) !== null) {
    const block = m[1];
    const loc = (block.match(/<loc>\s*([^<]+?)\s*<\/loc>/i) || [])[1];
    if (!loc) continue;
    entries.push({
      loc: loc.trim(),
      lastmod: ((block.match(/<lastmod>\s*([^<]+?)\s*<\/lastmod>/i) || [])[1] || "").trim() || undefined,
    });
  }
  return { entries, nested };
}

async function loadSitemap(url: string): Promise<{ entries: SitemapEntry[]; nested: string[] }> {
  const res = await fetchWithRetry(url, { headers: { Accept: "application/xml,text/xml;q=0.9,*/*;q=0.5" } });
  if (!res.ok) return { entries: [], nested: [] };
  const xml = await res.text();
  return parseSitemapXml(xml);
}

export const sitemapConnector: ConnectorProvider = {
  type: "sitemap",
  requiresAuth: false,
  describe: () => "Crawl a sitemap.xml or sitemap_index.xml, indexing each URL.",
  schema: () => ({
    type: "sitemap",
    requiresAuth: false,
    summary: "Crawl a sitemap.xml or sitemap_index.xml, indexing each URL.",
    positionalHint: "<url>",
    fields: [
      { name: "url", required: true, type: "string", description: "Sitemap URL (sitemaps.org, sitemap.xml, or sitemap_index.xml).", cliFlag: "url", positional: "url" },
      { name: "maxUrls", required: false, type: "number", description: "Cap on URLs to crawl.", default: 25, cliFlag: "max-urls" },
    ],
    example: { url: "https://www.bbc.com/sitemap.xml", maxUrls: 25 },
  }),
  validateConfig(config) {
    const u = String((config as any)?.url || "").trim();
    if (!u) return { ok: false, error: "config.url is required" };
    try { new URL(u); } catch { return { ok: false, error: `invalid URL: ${u}` }; }
    return { ok: true };
  },
  async sync({ source, signal, onProgress }) {
    const cfg: SitemapConfig = {
      url: String((source.config as any).url),
      maxPages: Number((source.config as any).maxPages || 50),
    };
    onProgress?.({ stage: "fetching", current: 0, total: 0, message: `Loading sitemap ${cfg.url}` });

    const seen = new Set<string>();
    const all: SitemapEntry[] = [];
    const queue: string[] = [cfg.url];
    while (queue.length > 0 && all.length < cfg.maxPages!) {
      const next = queue.shift()!;
      if (seen.has(next)) continue;
      seen.add(next);
      const { entries, nested } = await loadSitemap(next);
      for (const e of entries) {
        if (!seen.has(e.loc) && all.length < cfg.maxPages!) all.push(e);
      }
      for (const n of nested) if (!seen.has(n)) queue.push(n);
    }
    onProgress?.({ stage: "fetching", current: all.length, total: all.length, message: `Discovered ${all.length} URLs` });

    const docs = [];
    for (let i = 0; i < all.length; i++) {
      if (signal?.aborted) throw new Error("SYNC_ABORTED");
      const e = all[i];
      onProgress?.({ stage: "extracting", current: i + 1, total: all.length, message: `Fetching ${e.loc}` });
      try {
        const res = await fetchWithRetry(e.loc, { signal });
        if (!res.ok) continue;
        const html = await res.text();
        const text = htmlToText(html, 200_000);
        if (!text) continue;
        docs.push({
          external_id: `sitemap:${e.loc}`,
          title: titleOf(html, e.loc),
          content: text,
          source_type: "sitemap" as const,
          metadata: { url: e.loc, lastmod: e.lastmod, sitemap: cfg.url },
        });
      } catch {
        // skip individual page failures, keep going
      }
    }
    onProgress?.({ stage: "done", current: docs.length, total: docs.length, message: `Indexed ${docs.length} pages` });
    return docs;
  },
};
