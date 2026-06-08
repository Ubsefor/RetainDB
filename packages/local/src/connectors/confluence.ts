import type { ConnectorProvider } from "./types.js";
import { fetchWithRetry, htmlToText, titleOf } from "./fetch.js";

interface ConfluenceConfig {
  baseUrl: string;
  email?: string;
  apiToken: string;
  spaceKeys?: string[];
  labels?: string[];
  maxPages?: number;
}

function asConfConfig(input: Record<string, unknown>): ConfluenceConfig {
  return {
    baseUrl: String(input.baseUrl || "").replace(/\/+$/, ""),
    email: typeof input.email === "string" ? input.email : undefined,
    apiToken: String(input.apiToken || ""),
    spaceKeys: Array.isArray(input.spaceKeys) ? input.spaceKeys.map(String) : undefined,
    labels: Array.isArray(input.labels) ? input.labels.map(String) : undefined,
    maxPages: typeof input.maxPages === "number" ? input.maxPages : 50,
  };
}

async function cqlFetch(path: string, cfg: ConfluenceConfig, params: Record<string, string> = {}): Promise<any> {
  const url = new URL(`${cfg.baseUrl}/wiki/rest/api${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const auth = cfg.email
    ? "Basic " + Buffer.from(`${cfg.email}:${cfg.apiToken}`).toString("base64")
    : "Bearer " + cfg.apiToken;
  const res = await fetchWithRetry(url.toString(), { headers: { Authorization: auth, Accept: "application/json" } });
  if (!res.ok) throw new Error(`Confluence ${res.status} on ${path}`);
  return res.json();
}

export const confluenceConnector: ConnectorProvider = {
  type: "confluence",
  requiresAuth: true,
  describe: () => "Index Confluence spaces/pages by CQL (Cloud: email+API token, Server: PAT).",
  schema: () => ({
    type: "confluence",
    requiresAuth: true,
    summary: "Index Confluence spaces/pages by CQL (Cloud: email+API token, Server: PAT).",
    fields: [
      { name: "baseUrl", required: true, type: "string", description: "Confluence base URL, e.g. https://acme.atlassian.net.", cliFlag: "base-url" },
      { name: "apiToken", required: true, type: "string", description: "API token (Cloud: with email; Server: PAT).", cliFlag: "api-token", secret: true },
      { name: "email", required: false, type: "string", description: "Atlassian account email (Cloud only, used as Basic auth user).", cliFlag: "email" },
      { name: "spaceKeys", required: false, type: "string[]", description: "CQL: limit to these space keys (comma-separated).", cliFlag: "space-keys" },
      { name: "labels", required: false, type: "string[]", description: "CQL: filter by these labels (comma-separated).", cliFlag: "labels" },
      { name: "maxPages", required: false, type: "number", description: "Per-search page cap.", default: 50, cliFlag: "max-pages" },
    ],
    example: { baseUrl: "https://acme.atlassian.net", email: "you@acme.com", apiToken: "…", spaceKeys: ["ENG"] },
  }),
  validateConfig(config) {
    const c = asConfConfig(config);
    if (!c.baseUrl) return { ok: false, error: "config.baseUrl is required (e.g. https://acme.atlassian.net)" };
    if (!c.apiToken) return { ok: false, error: "config.apiToken is required" };
    if (!c.spaceKeys?.length && !c.labels?.length) {
      return { ok: false, error: "Provide config.spaceKeys or config.labels" };
    }
    return { ok: true };
  },
  async sync({ source, signal, onProgress }) {
    const cfg = asConfConfig(source.config);
    const cqlParts: string[] = [];
    if (cfg.spaceKeys?.length) cqlParts.push(`space IN (${cfg.spaceKeys.map((k) => `"${k}"`).join(",")})`);
    if (cfg.labels?.length) cqlParts.push(`label IN (${cfg.labels.map((l) => `"${l}"`).join(",")})`);
    const cql = cqlParts.join(" AND ");
    onProgress?.({ stage: "fetching", current: 0, total: 0, message: `Confluence CQL: ${cql}` });
    const r = await cqlFetch("/content/search", cfg, { cql, limit: String(cfg.maxPages!), expand: "body.view,space" });
    const results = (r.results || []).slice(0, cfg.maxPages!);
    const docs = [];
    for (let i = 0; i < results.length; i++) {
      if (signal?.aborted) throw new Error("SYNC_ABORTED");
      const page = results[i];
      onProgress?.({ stage: "extracting", current: i + 1, total: results.length, message: page.title });
      const html = page?.body?.view?.value || "";
      const text = htmlToText(html, 200_000);
      if (!text) continue;
      docs.push({
        external_id: `confluence:${page.id}`,
        title: page.title || titleOf(html, page.id),
        content: text,
        source_type: "confluence" as const,
        metadata: { pageId: page.id, spaceKey: page.space?.key, baseUrl: cfg.baseUrl, url: `${cfg.baseUrl}/wiki${page._links?.webui || ""}` },
      });
    }
    onProgress?.({ stage: "done", current: docs.length, total: docs.length, message: `Indexed ${docs.length} Confluence pages` });
    return docs;
  },
};
