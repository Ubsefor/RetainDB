import { ingestDocument } from "../engine/ingest.js";
import { synthesizeDocument, formatSynthesis } from "../engine/synthesis.js";
import { generateSourceProfile } from "../engine/source-extraction.js";

interface NotionConfig {
  token: string;
  databaseId?: string;
  pageIds?: string[];
  rootPageId?: string;
  maxPages?: number;
  maxBlocksPerPage?: number;
  includeChildPages?: boolean;
}

interface NotionProgress {
  stage: "discovering" | "indexing" | "done";
  current: number;
  total: number;
  message: string;
}

const NOTION_API = "https://api.notion.com/v1";
const DEFAULT_MAX_PAGES = 500;
const DEFAULT_MAX_BLOCKS_PER_PAGE = 5000;

async function notionFetch(path: string, token: string, opts: RequestInit = {}) {
  const res = await fetch(`${NOTION_API}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
      ...opts.headers,
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Notion API error: ${res.status}${body ? ` - ${body.slice(0, 180)}` : ""}`);
  }
  return res.json();
}

function richTextToPlain(richText: any[]): string {
  return (richText || []).map((t: any) => t.plain_text || "").join("");
}

function richTextToMd(richText: any[]): string {
  return (richText || []).map((t: any) => {
    let text = t.plain_text || "";
    if (!text) return "";
    if (t.annotations?.bold) text = `**${text}**`;
    if (t.annotations?.italic) text = `*${text}*`;
    if (t.annotations?.code) text = `\`${text}\``;
    if (t.annotations?.strikethrough) text = `~~${text}~~`;
    if (t.href) text = `[${text}](${t.href})`;
    return text;
  }).join("");
}

function compactText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** Convert a Notion property value to a human-readable string */
function propertyToText(key: string, prop: any): string | null {
  if (!prop) return null;
  const type = prop.type;

  switch (type) {
    case "title":
      return null; // already used as document title

    case "rich_text": {
      const text = compactText(richTextToPlain(prop.rich_text || []));
      return text ? `${key}: ${text}` : null;
    }

    case "number":
      return prop.number !== null && prop.number !== undefined
        ? `${key}: ${prop.number}`
        : null;

    case "select":
      return prop.select?.name ? `${key}: ${prop.select.name}` : null;

    case "multi_select": {
      const values = (prop.multi_select || []).map((s: any) => s.name).filter(Boolean);
      return values.length > 0 ? `${key}: ${values.join(", ")}` : null;
    }

    case "status":
      return prop.status?.name ? `${key}: ${prop.status.name}` : null;

    case "date": {
      const d = prop.date;
      if (!d?.start) return null;
      const range = d.end ? `${d.start} → ${d.end}` : d.start;
      return `${key}: ${range}`;
    }

    case "checkbox":
      return `${key}: ${prop.checkbox ? "Yes" : "No"}`;

    case "url":
      return prop.url ? `${key}: ${prop.url}` : null;

    case "email":
      return prop.email ? `${key}: ${prop.email}` : null;

    case "phone_number":
      return prop.phone_number ? `${key}: ${prop.phone_number}` : null;

    case "people": {
      const names = (prop.people || []).map((p: any) => p.name || p.id).filter(Boolean);
      return names.length > 0 ? `${key}: ${names.join(", ")}` : null;
    }

    case "created_by":
      return prop.created_by?.name ? `${key}: ${prop.created_by.name}` : null;

    case "last_edited_by":
      return prop.last_edited_by?.name ? `${key}: ${prop.last_edited_by.name}` : null;

    case "created_time":
      return prop.created_time ? `${key}: ${prop.created_time}` : null;

    case "last_edited_time":
      return prop.last_edited_time ? `${key}: ${prop.last_edited_time}` : null;

    case "formula": {
      const f = prop.formula;
      if (!f) return null;
      const val = f.string ?? f.number ?? f.boolean ?? (f.date?.start);
      return val !== null && val !== undefined ? `${key}: ${val}` : null;
    }

    case "rollup": {
      const r = prop.rollup;
      if (!r) return null;
      if (r.type === "number" && r.number !== null) return `${key}: ${r.number}`;
      if (r.type === "date" && r.date?.start) return `${key}: ${r.date.start}`;
      if (r.type === "array") {
        const items = (r.array || [])
          .map((item: any) => propertyToText("", item))
          .filter(Boolean)
          .map((s: string) => s.replace(/^:\s*/, ""));
        return items.length > 0 ? `${key}: ${items.join(", ")}` : null;
      }
      return null;
    }

    case "relation": {
      // IDs only — we can't resolve them without extra API calls
      const ids = (prop.relation || []).map((r: any) => r.id).filter(Boolean);
      return ids.length > 0 ? `${key}: ${ids.length} linked item(s)` : null;
    }

    case "files": {
      const files = (prop.files || []).map((f: any) => f.name || f.external?.url || f.file?.url).filter(Boolean);
      return files.length > 0 ? `${key}: ${files.join(", ")}` : null;
    }

    default:
      return null;
  }
}

/** Convert all Notion properties to a flat text block */
function propertiesToText(properties: Record<string, any>): { text: string; metadata: Record<string, any> } {
  const lines: string[] = [];
  const metadata: Record<string, any> = {};

  for (const [key, prop] of Object.entries(properties)) {
    if (!prop || prop.type === "title") continue;
    const text = propertyToText(key, prop);
    if (text) lines.push(text);

    // Also store select/multi_select/status in metadata for filtering
    const type = prop.type;
    if (type === "select" && prop.select?.name) metadata[key] = prop.select.name;
    if (type === "multi_select") metadata[key] = (prop.multi_select || []).map((s: any) => s.name);
    if (type === "status" && prop.status?.name) metadata[key] = prop.status.name;
    if (type === "checkbox") metadata[key] = prop.checkbox;
    if (type === "date" && prop.date?.start) metadata[key] = prop.date.start;
    if (type === "number" && prop.number !== null) metadata[key] = prop.number;
    if (type === "url" && prop.url) metadata[key] = prop.url;
    if (type === "email" && prop.email) metadata[key] = prop.email;
    if (type === "people") metadata[key] = (prop.people || []).map((p: any) => p.name).filter(Boolean);
    if (type === "created_time") metadata[key] = prop.created_time;
    if (type === "last_edited_time") metadata[key] = prop.last_edited_time;
  }

  return { text: lines.join("\n"), metadata };
}

function renderBlock(block: any, depth: number): string {
  const indent = "  ".repeat(Math.min(depth, 4));
  const type = block?.type;
  if (!type || !block[type]) return "";

  switch (type) {
    case "paragraph":
      return `${indent}${compactText(richTextToMd(block[type].rich_text || []))}`;
    case "quote":
      return `${indent}> ${compactText(richTextToMd(block[type].rich_text || []))}`;
    case "callout": {
      const icon = block[type].icon?.emoji || block[type].icon?.external?.url || "";
      const text = compactText(richTextToMd(block[type].rich_text || []));
      return `${indent}${icon ? `${icon} ` : ""}${text}`;
    }
    case "toggle":
      return `${indent}${compactText(richTextToMd(block[type].rich_text || []))}`;
    case "heading_1":
      return `# ${compactText(richTextToMd(block[type].rich_text || []))}`;
    case "heading_2":
      return `## ${compactText(richTextToMd(block[type].rich_text || []))}`;
    case "heading_3":
      return `### ${compactText(richTextToMd(block[type].rich_text || []))}`;
    case "bulleted_list_item":
      return `${indent}- ${compactText(richTextToMd(block[type].rich_text || []))}`;
    case "numbered_list_item":
      return `${indent}1. ${compactText(richTextToMd(block[type].rich_text || []))}`;
    case "to_do": {
      const checked = block[type].checked ? "x" : " ";
      return `${indent}- [${checked}] ${compactText(richTextToMd(block[type].rich_text || []))}`;
    }
    case "code": {
      const lang = block[type].language || "";
      const code = richTextToPlain(block[type].rich_text || []);
      const caption = richTextToPlain(block[type].caption || []);
      return `\`\`\`${lang}\n${code}\n\`\`\`${caption ? `\n*${caption}*` : ""}`;
    }
    case "equation":
      return `${indent}$$${block[type].expression || ""}$$`;
    case "divider":
      return "---";
    case "child_page":
      return `[Child page: ${block[type].title || "Untitled"}]`;
    case "child_database":
      return `[Child database: ${block[type].title || "Untitled"}]`;
    case "bookmark": {
      const url = block[type].url || "";
      const caption = richTextToPlain(block[type].caption || []);
      return `${indent}[${caption || url}](${url})`;
    }
    case "link_preview":
      return `${indent}[Link preview](${block[type].url || ""})`;
    case "link_to_page": {
      const target = block[type].page_id || block[type].database_id || "";
      return target ? `${indent}[Linked page: ${target}]` : "";
    }
    case "image":
    case "file":
    case "pdf":
    case "video":
    case "audio": {
      const fileRef = block[type]?.external?.url || block[type]?.file?.url || "";
      const caption = richTextToPlain(block[type]?.caption || []);
      if (!fileRef) return "";
      return caption
        ? `${indent}[${type.toUpperCase()}: ${fileRef}]\n${indent}*${caption}*`
        : `${indent}[${type.toUpperCase()}: ${fileRef}]`;
    }
    case "table_row": {
      const cells = (block[type].cells || []).map((cell: any[]) =>
        compactText(richTextToPlain(cell)),
      );
      return cells.length ? `${indent}| ${cells.join(" | ")} |` : "";
    }
    case "synced_block":
      // synced_block contains its own children — handled by recursive traversal
      return "";
    case "column_list":
    case "column":
      return ""; // children are traversed recursively
    case "breadcrumb":
      return "";
    case "template":
      return `${indent}${compactText(richTextToMd(block[type].rich_text || []))}`;
    default:
      return "";
  }
}

function extractPageTitle(page: any): string {
  const props = page?.properties || {};
  for (const prop of Object.values(props) as any[]) {
    if (prop?.type === "title" && prop.title?.length) {
      return compactText(richTextToPlain(prop.title));
    }
  }
  // Fallback to page object's own title (for non-database pages)
  if (page?.properties?.title?.title?.length) {
    return compactText(richTextToPlain(page.properties.title.title));
  }
  return "Untitled";
}

function extractPageIcon(page: any): string {
  const icon = page?.icon;
  if (!icon) return "";
  if (icon.type === "emoji") return icon.emoji || "";
  if (icon.type === "external") return icon.external?.url || "";
  if (icon.type === "file") return icon.file?.url || "";
  return "";
}

function extractPageCover(page: any): string {
  const cover = page?.cover;
  if (!cover) return "";
  return cover.external?.url || cover.file?.url || "";
}

function notionPageUrl(pageId: string): string {
  return `https://www.notion.so/${pageId.replace(/-/g, "")}`;
}

type PageContentResult = {
  title: string;
  content: string;
  propertyText: string;
  propertyMetadata: Record<string, any>;
  childPageIds: string[];
  blockCount: number;
  icon: string;
  cover: string;
  pageUrl: string;
  createdTime: string;
  lastEditedTime: string;
  createdBy: string;
  lastEditedBy: string;
};

async function collectBlocksRecursive(
  parentId: string,
  token: string,
  depth: number,
  lines: string[],
  childPageIds: Set<string>,
  visitedBlocks: Set<string>,
  budget: { remaining: number },
) {
  if (budget.remaining <= 0) return;

  let cursor: string | undefined;
  do {
    if (budget.remaining <= 0) break;
    const query = new URLSearchParams({ page_size: "100" });
    if (cursor) query.set("start_cursor", cursor);
    const response = await notionFetch(`/blocks/${parentId}/children?${query.toString()}`, token);
    const blocks = response.results || [];

    for (const block of blocks) {
      if (budget.remaining <= 0) break;
      if (!block?.id || visitedBlocks.has(block.id)) continue;
      visitedBlocks.add(block.id);
      budget.remaining -= 1;

      const text = renderBlock(block, depth);
      if (text) lines.push(text);

      if (block.type === "child_page" && block.id) {
        childPageIds.add(block.id);
      }

      if (block.has_children && !["child_page", "child_database"].includes(block.type)) {
        await collectBlocksRecursive(
          block.id,
          token,
          depth + 1,
          lines,
          childPageIds,
          visitedBlocks,
          budget,
        );
      }
    }

    cursor = response.has_more ? response.next_cursor : undefined;
  } while (cursor);
}

async function collectPageContent(
  pageId: string,
  token: string,
  maxBlocksPerPage: number,
): Promise<PageContentResult> {
  const page = await notionFetch(`/pages/${pageId}`, token);
  const title = extractPageTitle(page);
  const icon = extractPageIcon(page);
  const cover = extractPageCover(page);
  const pageUrl = notionPageUrl(pageId);

  // Extract all properties
  const { text: propertyText, metadata: propertyMetadata } = propertiesToText(
    page.properties || {},
  );

  const lines: string[] = [];
  const childPageIds = new Set<string>();
  const visitedBlocks = new Set<string>();
  const budget = { remaining: maxBlocksPerPage };

  await collectBlocksRecursive(pageId, token, 0, lines, childPageIds, visitedBlocks, budget);
  const blockContent = lines.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();

  // Build full content: properties first, then block content
  const contentParts: string[] = [];
  if (propertyText) {
    contentParts.push("[Page Properties]");
    contentParts.push(propertyText);
    contentParts.push("");
  }
  if (blockContent) {
    contentParts.push("[Page Content]");
    contentParts.push(blockContent);
  }

  const content = contentParts.join("\n").trim();

  return {
    title,
    content,
    propertyText,
    propertyMetadata,
    childPageIds: [...childPageIds],
    blockCount: maxBlocksPerPage - budget.remaining,
    icon,
    cover,
    pageUrl,
    createdTime: page.created_time || "",
    lastEditedTime: page.last_edited_time || "",
    createdBy: page.created_by?.name || page.created_by?.id || "",
    lastEditedBy: page.last_edited_by?.name || page.last_edited_by?.id || "",
  };
}

async function queryDatabasePages(databaseId: string, token: string, maxPages: number) {
  const ids: string[] = [];
  let cursor: string | undefined;

  while (ids.length < maxPages) {
    const body: Record<string, any> = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;

    const response = await notionFetch(`/databases/${databaseId}/query`, token, {
      method: "POST",
      body: JSON.stringify(body),
    });

    for (const page of response.results || []) {
      if (page?.id) ids.push(page.id);
      if (ids.length >= maxPages) break;
    }

    if (!response.has_more || !response.next_cursor) break;
    cursor = response.next_cursor;
  }

  return ids.slice(0, maxPages);
}

export async function syncNotion(
  sourceId: string,
  projectId: string,
  config: NotionConfig,
  onProgress?: (progress: NotionProgress) => void,
  signal?: AbortSignal,
) {
  const {
    token,
    maxPages = DEFAULT_MAX_PAGES,
    maxBlocksPerPage = DEFAULT_MAX_BLOCKS_PER_PAGE,
    includeChildPages = true,
  } = config;

  if (!token) {
    throw new Error(
      "Notion requires 'token' in config. Get an integration token from Notion integrations settings.",
    );
  }

  const seedPageIds = new Set<string>();
  for (const pageId of config.pageIds || []) {
    if (pageId) seedPageIds.add(pageId);
  }
  if (config.rootPageId) seedPageIds.add(config.rootPageId);
  if (config.databaseId) {
    const dbPageIds = await queryDatabasePages(config.databaseId, token, maxPages);
    for (const pageId of dbPageIds) seedPageIds.add(pageId);
  }

  const queue = [...seedPageIds];
  const queued = new Set(queue);
  const visited = new Set<string>();
  const errors: string[] = [];
  let indexed = 0;

  onProgress?.({
    stage: "discovering",
    current: 0,
    total: Math.max(queue.length, 1),
    message: `Discovered ${queue.length} seed page(s)`,
  });

  while (queue.length > 0 && indexed < maxPages) {
    if (signal?.aborted) throw new Error("SYNC_ABORTED");
    const pageId = queue.shift()!;
    queued.delete(pageId);
    if (visited.has(pageId)) continue;
    visited.add(pageId);

    onProgress?.({
      stage: "indexing",
      current: indexed,
      total: maxPages,
      message: `Indexing Notion page ${indexed + 1}/${maxPages}...`,
    });

    try {
      const page = await collectPageContent(pageId, token, maxBlocksPerPage);

      if (page.content.length >= 10) {
        const pageMetadata: Record<string, any> = {
          source: "notion",
          source_type: "notion",
          pageId,
          pageUrl: page.pageUrl,
          databaseId: config.databaseId || null,
          rootPageId: config.rootPageId || null,
          blockCount: page.blockCount,
          icon: page.icon || null,
          cover: page.cover || null,
          createdTime: page.createdTime || null,
          lastEditedTime: page.lastEditedTime || null,
          createdBy: page.createdBy || null,
          lastEditedBy: page.lastEditedBy || null,
          // Embed structured properties as metadata for filtering
          ...page.propertyMetadata,
        };

        // Generate synthesis per page for rich retrieval
        const synthesis = await synthesizeDocument(page.content, "notion", page.title, {
          url: page.pageUrl,
          ...(page.createdTime ? { created: page.createdTime } : {}),
          ...(page.lastEditedTime ? { updated: page.lastEditedTime } : {}),
        });

        if (synthesis) {
          const synthesisContent = formatSynthesis(synthesis, page.title);
          await ingestDocument({
            sourceId,
            projectId,
            externalId: `notion-${pageId}#synthesis`,
            title: `${page.title} — Overview`,
            content: synthesisContent,
            metadata: { ...pageMetadata, is_synthesis: true },
            sourceType: "notion",
            ingestionProfile: "web_docs",
          });
        }

        // Index full page content
        await ingestDocument({
          sourceId,
          projectId,
          externalId: `notion-${pageId}`,
          title: page.icon ? `${page.icon} ${page.title}` : page.title,
          content: page.content,
          metadata: pageMetadata,
          webUrl: page.pageUrl,
          sourceType: "notion",
          ingestionProfile: "web_docs",
        });

        indexed++;
      }

      if (includeChildPages) {
        for (const childId of page.childPageIds) {
          if (visited.has(childId) || queued.has(childId)) continue;
          queue.push(childId);
          queued.add(childId);
        }
      }
    } catch (error: any) {
      errors.push(`Page ${pageId}: ${error?.message || "unknown error"}`);
    }
  }

  onProgress?.({
    stage: "done",
    current: indexed,
    total: indexed,
    message: `Indexed ${indexed} Notion pages`,
  });

  if (indexed > 0) {
    generateSourceProfile(sourceId, projectId, { sourceType: "notion" }).catch(() => {});
  }

  return {
    pagesIndexed: indexed,
    pagesDiscovered: visited.size,
    errors: errors.slice(0, 20),
    truncated: errors.length > 20,
  };
}
