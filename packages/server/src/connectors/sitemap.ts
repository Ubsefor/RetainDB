import * as cheerio from "cheerio";
import { ingestDocument } from "../engine/ingest.js";
import { extractStructuredHtml } from "./html-structure.js";
import { generateSourceProfile } from "../engine/source-extraction.js";

interface SitemapConfig {
  url: string;
  selector?: string;
  maxPages?: number;
}

interface SitemapEntry {
  loc: string;
  lastmod?: string;
  priority?: string;
  changefreq?: string;
}

function parseUrlsFromXml(xml: string): { entries: SitemapEntry[]; nestedSitemaps: string[] } {
  const $ = cheerio.load(xml, { xmlMode: true });
  const entries: SitemapEntry[] = [];
  const nestedSitemaps: string[] = [];

  $("sitemap > loc").each((_, el) => {
    const loc = $(el).text().trim();
    if (loc) nestedSitemaps.push(loc);
  });

  $("url").each((_, el) => {
    const loc = $(el).find("loc").first().text().trim();
    if (!loc) return;
    entries.push({
      loc,
      lastmod: $(el).find("lastmod").first().text().trim() || undefined,
      priority: $(el).find("priority").first().text().trim() || undefined,
      changefreq: $(el).find("changefreq").first().text().trim() || undefined,
    });
  });

  return { entries, nestedSitemaps };
}

async function collectSitemapEntries(sitemapUrl: string, maxEntries: number): Promise<SitemapEntry[]> {
  const all: SitemapEntry[] = [];

  const res = await fetch(sitemapUrl, {
    headers: { "User-Agent": "RetainDB-indexer/1.0" },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`Failed to fetch sitemap: ${res.status} ${res.statusText}`);

  const { entries, nestedSitemaps } = parseUrlsFromXml(await res.text());
  all.push(...entries);

  // Fetch up to 10 nested sitemaps
  for (const nestedUrl of nestedSitemaps.slice(0, 10)) {
    if (all.length >= maxEntries) break;
    try {
      const nestedRes = await fetch(nestedUrl, {
        headers: { "User-Agent": "RetainDB-indexer/1.0" },
        signal: AbortSignal.timeout(15000),
      });
      if (!nestedRes.ok) continue;
      const { entries: nestedEntries } = parseUrlsFromXml(await nestedRes.text());
      all.push(...nestedEntries);
    } catch {
      // Skip failed nested sitemaps
    }
  }

  return all.slice(0, maxEntries);
}

export async function syncSitemap(
  sourceId: string,
  projectId: string,
  config: SitemapConfig,
) {
  const { selector, maxPages = 200 } = config;
  let sitemapUrl = config.url;

  if (!sitemapUrl) {
    throw new Error("Sitemap requires 'url' in config.");
  }

  if (!sitemapUrl.endsWith(".xml")) {
    sitemapUrl = sitemapUrl.replace(/\/$/, "") + "/sitemap.xml";
  }

  const entries = await collectSitemapEntries(sitemapUrl, maxPages);
  const rootUrl = new URL(sitemapUrl).origin;
  let indexed = 0;

  // Process in batches of 5
  for (let i = 0; i < entries.length; i += 5) {
    const batch = entries.slice(i, i + 5);

    await Promise.all(
      batch.map(async (entry) => {
        try {
          const pageRes = await fetch(entry.loc, {
            headers: { "User-Agent": "RetainDB-indexer/1.0" },
            signal: AbortSignal.timeout(20000),
          });
          if (!pageRes.ok) return;

          const ct = pageRes.headers.get("content-type") || "";
          if (!ct.includes("text/html")) return;

          const html = await pageRes.text();
          const structured = extractStructuredHtml(html, entry.loc, selector);

          if (!structured.content || structured.content.length < 10) return;

          const cleaned = structured.content
            .replace(/[ \t]+/g, " ")
            .replace(/\n{3,}/g, "\n\n")
            .trim();

          if (cleaned.length < 10) return;

          await ingestDocument({
            sourceId,
            projectId,
            externalId: entry.loc,
            title: structured.title,
            content: cleaned,
            metadata: {
              ...structured.metadata,
              source: "sitemap",
              design: structured.design,
              structuredDataTypes: structured.structuredData
                .map((d) => d["@type"])
                .filter(Boolean),
              ...(entry.lastmod ? { sitemapLastmod: entry.lastmod } : {}),
              ...(entry.priority ? { sitemapPriority: entry.priority } : {}),
              ...(entry.changefreq ? { sitemapChangefreq: entry.changefreq } : {}),
            },
            sourceType: "web",
            ingestionProfile: "web_docs",
          });

          indexed++;
        } catch {
          // Skip failed pages silently
        }
      }),
    );
  }

  if (indexed > 0) {
    generateSourceProfile(sourceId, projectId, { sourceType: "web", rootUrl }).catch(() => {});
  }

  return { pagesIndexed: indexed, totalUrls: entries.length };
}
