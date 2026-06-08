import type { ConnectorProvider } from "./types.js";
import { fetchWithRetry, htmlToText, titleOf } from "./fetch.js";

interface UrlConfig {
  urls: string[];
  maxBytes?: number;
}

function asUrlConfig(input: Record<string, unknown>): UrlConfig {
  const arr = Array.isArray(input.urls) ? input.urls : [];
  return {
    urls: arr.map((u) => String(u).trim()).filter(Boolean),
    maxBytes: typeof input.maxBytes === "number" ? input.maxBytes : 800_000,
  };
}

export const urlConnector: ConnectorProvider = {
  type: "url",
  requiresAuth: false,
  describe: () => "Index a list of public URLs (HTML → text each).",
  schema: () => ({
    type: "url",
    requiresAuth: false,
    summary: "Index a list of public URLs (HTML → text each).",
    positionalHint: "<url1,url2,...>",
    fields: [
      { name: "urls", required: true, type: "string[]", description: "Comma-separated URLs to fetch and extract.", cliFlag: "urls", positional: "urls" },
    ],
    example: { urls: ["https://example.com/", "https://www.iana.org/help/example-domains"] },
  }),
  validateConfig(config) {
    const c = asUrlConfig(config);
    if (c.urls.length === 0) return { ok: false, error: "config.urls must contain at least one URL" };
    for (const u of c.urls) {
      try { new URL(u); } catch { return { ok: false, error: `invalid URL: ${u}` }; }
    }
    return { ok: true };
  },
  async sync({ source, signal, onProgress }) {
    const cfg = asUrlConfig(source.config);
    const docs = [];
    for (let i = 0; i < cfg.urls.length; i++) {
      if (signal?.aborted) throw new Error("SYNC_ABORTED");
      const url = cfg.urls[i];
      onProgress?.({ stage: "fetching", current: i, total: cfg.urls.length, message: `Fetching ${url}` });
      const res = await fetchWithRetry(url, { signal });
      if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}`);
      const html = await res.text();
      const title = titleOf(html, url);
      const text = htmlToText(html, cfg.maxBytes || 800_000);
      docs.push({
        external_id: `url:${url}`,
        title,
        content: text,
        source_type: "url" as const,
        metadata: { url, fetched_at: new Date().toISOString() },
      });
    }
    onProgress?.({ stage: "done", current: docs.length, total: docs.length, message: `Fetched ${docs.length} URLs` });
    return docs;
  },
};
