import type { ConnectorProvider } from "./types.js";
import { fetchWithRetry } from "./fetch.js";

interface NotionConfig {
  token: string;
  pageIds?: string[];
  databaseIds?: string[];
  maxPages?: number;
}

function asNotionConfig(input: Record<string, unknown>): NotionConfig {
  return {
    token: String(input.token || "").trim(),
    pageIds: Array.isArray(input.pageIds) ? input.pageIds.map(String) : undefined,
    databaseIds: Array.isArray(input.databaseIds) ? input.databaseIds.map(String) : undefined,
    maxPages: typeof input.maxPages === "number" ? input.maxPages : 50,
  };
}

const NOTION_VERSION = "2022-06-28";

async function notion(path: string, token: string, body?: any): Promise<any> {
  const res = await fetchWithRetry(`https://api.notion.com/v1${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
  });
  // Notion returns 200 with body for POST; we always use POST via fetchWithRetry-compatible wrapper
  // Use direct fetch for body support
  const r2 = await fetch(`https://api.notion.com/v1${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r2.ok) throw new Error(`Notion ${r2.status} on ${path}: ${(await r2.text()).slice(0, 200)}`);
  return r2.json();
}

function blocksToText(blocks: any[]): string {
  const lines: string[] = [];
  for (const b of blocks || []) {
    const t = b?.type;
    if (!t) continue;
    const rich = b[t]?.rich_text;
    if (Array.isArray(rich)) {
      const txt = rich.map((r: any) => r?.plain_text || "").join("").trim();
      if (txt) lines.push(txt);
    }
    if (Array.isArray(b?.children)) lines.push(blocksToText(b.children));
  }
  return lines.join("\n\n");
}

async function fetchPage(pageId: string, token: string): Promise<{ id: string; title: string; text: string }> {
  const page = await notion(`/pages/${pageId}`, token);
  const titleProp = Object.values(page.properties || {}).find((p: any) => p?.type === "title");
  const title = (Array.isArray((titleProp as any)?.title) ? (titleProp as any).title.map((t: any) => t.plain_text).join("") : "") || pageId;
  const blocks = await notion(`/blocks/${pageId}/children?page_size=100`, token);
  const text = blocksToText(blocks.results || []);
  return { id: pageId, title, text };
}

async function fetchDatabasePages(databaseId: string, token: string, maxPages: number): Promise<Array<{ id: string; title: string; text: string }>> {
  const r = await notion(`/databases/${databaseId}/query`, token, { page_size: Math.min(100, maxPages) });
  const out: Array<{ id: string; title: string; text: string }> = [];
  for (const row of r.results || []) {
    if (out.length >= maxPages) break;
    const titleProp = Object.values(row.properties || {}).find((p: any) => p?.type === "title");
    const title = (Array.isArray((titleProp as any)?.title) ? (titleProp as any).title.map((t: any) => t.plain_text).join("") : "") || row.id;
    try {
      const blocks = await notion(`/blocks/${row.id}/children?page_size=100`, token);
      out.push({ id: row.id, title, text: blocksToText(blocks.results || []) });
    } catch {
      out.push({ id: row.id, title, text: "" });
    }
  }
  return out;
}

export const notionConnector: ConnectorProvider = {
  type: "notion",
  requiresAuth: true,
  describe: () => "Index Notion pages and database rows (Notion integration token).",
  schema: () => ({
    type: "notion",
    requiresAuth: true,
    summary: "Index Notion pages and database rows (Notion integration token).",
    fields: [
      { name: "token", required: true, type: "string", description: "Notion integration secret (secret_… or ntn_…).", cliFlag: "token", secret: true },
      { name: "pageIds", required: false, type: "string[]", description: "Specific page IDs to index (comma-separated).", cliFlag: "page-ids" },
      { name: "databaseIds", required: false, type: "string[]", description: "Database IDs to dump (comma-separated).", cliFlag: "database-ids" },
      { name: "maxPages", required: false, type: "number", description: "Per-database page cap.", default: 50, cliFlag: "max-pages" },
    ],
    example: { token: "secret_…", databaseIds: ["…"] },
  }),
  validateConfig(config) {
    const c = asNotionConfig(config);
    if (!c.token) return { ok: false, error: "config.token is required (Notion integration secret_… token)" };
    if (!c.token.startsWith("secret_") && !c.token.startsWith("ntn_")) {
      return { ok: false, error: "config.token should start with secret_ or ntn_" };
    }
    if (!c.pageIds?.length && !c.databaseIds?.length) {
      return { ok: false, error: "Provide config.pageIds or config.databaseIds" };
    }
    return { ok: true };
  },
  async sync({ source, signal, onProgress }) {
    const cfg = asNotionConfig(source.config);
    const docs = [];
    const pages: Array<{ id: string; title: string; text: string }> = [];
    for (const id of cfg.pageIds || []) {
      if (signal?.aborted) throw new Error("SYNC_ABORTED");
      onProgress?.({ stage: "fetching", current: pages.length, total: (cfg.pageIds?.length || 0) + (cfg.databaseIds?.length || 0), message: `Notion page ${id}` });
      try { pages.push(await fetchPage(id, cfg.token)); } catch { /* skip */ }
    }
    for (const db of cfg.databaseIds || []) {
      if (signal?.aborted) throw new Error("SYNC_ABORTED");
      onProgress?.({ stage: "fetching", current: pages.length, total: (cfg.pageIds?.length || 0) + (cfg.databaseIds?.length || 0), message: `Notion db ${db}` });
      try { pages.push(...await fetchDatabasePages(db, cfg.token, cfg.maxPages!)); } catch { /* skip */ }
    }
    for (let i = 0; i < pages.length; i++) {
      const p = pages[i];
      if (!p.text) continue;
      docs.push({
        external_id: `notion:${p.id}`,
        title: p.title,
        content: p.text,
        source_type: "notion" as const,
        metadata: { pageId: p.id, url: `https://www.notion.so/${p.id.replace(/-/g, "")}` },
      });
    }
    onProgress?.({ stage: "done", current: docs.length, total: docs.length, message: `Indexed ${docs.length} Notion pages` });
    return docs;
  },
};
