import type { ConnectorProvider } from "./types.js";
import { fetchWithRetry, htmlToText, titleOf } from "./fetch.js";

interface WebConfig {
  url: string;
  selector?: string;
  maxBytes?: number;
}

function asWebConfig(input: Record<string, unknown>): WebConfig {
  if (!input || typeof input.url !== "string" || !input.url.trim()) {
    return { url: "" };
  }
  return {
    url: String(input.url).trim(),
    selector: typeof input.selector === "string" ? input.selector : undefined,
    maxBytes: typeof input.maxBytes === "number" ? input.maxBytes : 1_500_000,
  };
}

export const webConnector: ConnectorProvider = {
  type: "web",
  requiresAuth: false,
  describe: () => "Index a single public web page (HTML → text).",
  schema: () => ({
    type: "web",
    requiresAuth: false,
    summary: "Index a single public web page (HTML → text).",
    positionalHint: "<url>",
    fields: [
      { name: "url", required: true, type: "string", description: "Public URL to fetch and extract.", cliFlag: "url", positional: "url" },
    ],
    example: { url: "https://example.com/" },
  }),
  validateConfig(config) {
    const c = asWebConfig(config);
    if (!c.url) return { ok: false, error: "config.url is required" };
    try {
      new URL(c.url);
    } catch {
      return { ok: false, error: `config.url is not a valid URL: ${c.url}` };
    }
    return { ok: true };
  },
  async sync({ source, signal }) {
    const cfg = asWebConfig(source.config);
    const res = await fetchWithRetry(cfg.url, { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${cfg.url}`);
    const html = await res.text();
    const title = titleOf(html, cfg.url);
    const text = htmlToText(html, cfg.maxBytes || 1_500_000);
    return [
      {
        external_id: `web:${cfg.url}`,
        title,
        content: text,
        source_type: "web",
        metadata: { url: cfg.url, fetched_at: new Date().toISOString(), bytes: html.length, textBytes: text.length },
      },
    ];
  },
};
