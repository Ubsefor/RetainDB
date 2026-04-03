import * as cheerio from "cheerio";
import { ingestDocument } from "../engine/ingest.js";
import { synthesizeDocument, formatSynthesis } from "../engine/synthesis.js";
import { generateSourceProfile } from "../engine/source-extraction.js";

interface ConfluenceConfig {
  baseUrl: string; // e.g. https://yoursite.atlassian.net/wiki
  email: string;
  apiToken: string;
  spaceKey?: string;
  pageIds?: string[];
  maxPages?: number;
}

async function confluenceFetch(baseUrl: string, path: string, email: string, apiToken: string) {
  const auth = Buffer.from(`${email}:${apiToken}`).toString("base64");
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/rest/api${path}`, {
    headers: {
      Authorization: `Basic ${auth}`,
      Accept: "application/json",
    },
  });
  if (!res.ok) throw new Error(`Confluence API error: ${res.status}`);
  return res.json();
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Convert Confluence storage format HTML to structured Markdown.
 * Much richer than the previous $.text() approach — preserves headings,
 * tables, code, lists, links, macros, callouts.
 */
function confluenceHtmlToMarkdown(html: string): string {
  const $ = cheerio.load(html);

  // Unwrap Confluence-specific macro wrappers we want to keep content of
  $("ac\\:rich-text-body, ac\\:plain-text-body").each((_, el) => {
    $(el).replaceWith($(el).html() || "");
  });

  // Code blocks — Confluence uses <ac:structured-macro ac:name="code">
  $("ac\\:structured-macro[ac\\:name='code'], ac\\:structured-macro[ac\\:name='noformat']").each(
    (_, el) => {
      const lang =
        $(el).find("ac\\:parameter[ac\\:name='language']").text().trim() || "";
      const code = $(el).find("ac\\:plain-text-body").text() ||
        $(el).find("ac\\:rich-text-body").text() ||
        $(el).text();
      $(el).replaceWith(`\n\`\`\`${lang}\n${code.trim()}\n\`\`\`\n`);
    },
  );

  // Info/warning/note panels
  $("ac\\:structured-macro[ac\\:name='info'], ac\\:structured-macro[ac\\:name='note'], ac\\:structured-macro[ac\\:name='warning'], ac\\:structured-macro[ac\\:name='tip']").each(
    (_, el) => {
      const name = $(el).attr("ac:name") || "note";
      const body = $(el).find("ac\\:rich-text-body").text().trim();
      if (body) $(el).replaceWith(`\n> **[${name.toUpperCase()}]** ${body}\n`);
      else $(el).remove();
    },
  );

  // Remove all other macros cleanly
  $("ac\\:structured-macro").each((_, el) => {
    const body = $(el).find("ac\\:rich-text-body").text().trim();
    $(el).replaceWith(body ? body : "");
  });

  // Task lists
  $("ac\\:task-list").each((_, el) => {
    const tasks = $(el)
      .find("ac\\:task")
      .map((_, task) => {
        const status = $(task).find("ac\\:task-status").text().trim();
        const body = $(task).find("ac\\:task-body").text().trim();
        return `- [${status === "complete" ? "x" : " "}] ${body}`;
      })
      .get();
    $(el).replaceWith(tasks.join("\n"));
  });

  // User mentions
  $("ac\\:link, ri\\:user").each((_, el) => {
    const username =
      $(el).attr("ri:username") || $(el).attr("ac:link-body") || "";
    const label = $(el).find("ac\\:plain-text-link-body").text().trim();
    $(el).replaceWith(label || (username ? `@${username}` : ""));
  });

  // Page/attachment links
  $("ac\\:link").each((_, el) => {
    const pageTitle = $(el).find("ri\\:page").attr("ri:content-title") || "";
    const label = $(el).find("ac\\:plain-text-link-body").text().trim() ||
      $(el).find("ac\\:link-body").text().trim();
    $(el).replaceWith(label || pageTitle || "");
  });

  // Strip remaining Confluence XML tags
  $("ac\\:image, ri\\:attachment, ri\\:page, ri\\:url").each((_, el) => {
    const caption = $(el).find("ac\\:caption").text().trim();
    if (caption) $(el).replaceWith(`[Image: ${caption}]`);
    else $(el).remove();
  });

  // Now convert standard HTML elements
  $("script, style, noscript").remove();

  // Convert headings
  $("h1, h2, h3, h4, h5, h6").each((_, el) => {
    const level = Number(el.tagName[1]);
    const text = cleanText($(el).text());
    if (text) $(el).replaceWith(`\n${"#".repeat(level)} ${text}\n`);
  });

  // Convert code
  $("pre").each((_, el) => {
    const lang = $(el).find("code").attr("class")?.replace("language-", "") || "";
    const code = $(el).text().trim();
    $(el).replaceWith(`\n\`\`\`${lang}\n${code}\n\`\`\`\n`);
  });
  $("code").each((_, el) => {
    if ($(el).parent().is("pre")) return;
    $(el).replaceWith(`\`${$(el).text()}\``);
  });

  // Convert tables to Markdown
  $("table").each((_, tableEl) => {
    const rows: string[] = [];
    let headerDone = false;
    $(tableEl)
      .find("tr")
      .each((_, row) => {
        const cells = $(row)
          .find("th, td")
          .map((_, cell) => cleanText($(cell).text()))
          .get();
        if (cells.length === 0) return;
        rows.push(`| ${cells.join(" | ")} |`);
        if (!headerDone && $(row).find("th").length > 0) {
          rows.push(`| ${cells.map(() => "---").join(" | ")} |`);
          headerDone = true;
        }
      });
    if (rows.length > 0) $(tableEl).replaceWith("\n" + rows.join("\n") + "\n");
  });

  // Convert lists
  $("ul, ol").each((_, listEl) => {
    const isOrdered = listEl.tagName === "ol";
    $(listEl)
      .children("li")
      .each((idx, li) => {
        const text = cleanText($(li).text());
        if (text) $(li).replaceWith(`\n${isOrdered ? `${idx + 1}.` : "-"} ${text}`);
      });
    $(listEl).replaceWith($(listEl).html() || "");
  });

  // Convert links
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") || "";
    const text = cleanText($(el).text());
    if (text && href) $(el).replaceWith(`[${text}](${href})`);
    else if (text) $(el).replaceWith(text);
  });

  // Convert emphasis
  $("strong, b").each((_, el) => {
    const text = $(el).text();
    if (text.trim()) $(el).replaceWith(`**${text}**`);
  });
  $("em, i").each((_, el) => {
    const text = $(el).text();
    if (text.trim()) $(el).replaceWith(`*${text}*`);
  });

  // Convert blockquotes
  $("blockquote").each((_, el) => {
    const text = cleanText($(el).text());
    if (text) $(el).replaceWith(`\n> ${text}\n`);
  });

  // Convert paragraphs and divs
  $("p, div").each((_, el) => {
    const text = cleanText($(el).text());
    if (text) $(el).replaceWith(`\n${text}\n`);
  });

  return $("body")
    .text()
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

interface PageInfo {
  id: string;
  title: string;
  content: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  updatedBy: string;
  ancestors: string[];
  labels: string[];
  spaceKey: string;
  webUrl: string;
  childrenCount: number;
}

async function fetchPageInfo(
  baseUrl: string,
  pageId: string,
  email: string,
  apiToken: string,
): Promise<PageInfo | null> {
  try {
    const page = await confluenceFetch(
      baseUrl,
      `/content/${pageId}?expand=body.storage,space,version,history.createdBy,history.lastUpdated,ancestors,children.page,metadata.labels`,
      email,
      apiToken,
    );

    const content = confluenceHtmlToMarkdown(page.body?.storage?.value || "");
    const labels = (page.metadata?.labels?.results || [])
      .map((l: any) => l.name)
      .filter(Boolean);
    const ancestors = (page.ancestors || [])
      .map((a: any) => a.title)
      .filter(Boolean);
    const webPath = page._links?.webui || "";

    return {
      id: page.id,
      title: page.title || "Untitled",
      content,
      version: page.version?.number || 1,
      createdAt: page.history?.createdDate || "",
      updatedAt: page.version?.when || "",
      createdBy: page.history?.createdBy?.displayName || page.history?.createdBy?.username || "",
      updatedBy: page.version?.by?.displayName || page.version?.by?.username || "",
      ancestors,
      labels,
      spaceKey: page.space?.key || "",
      webUrl: webPath ? `${baseUrl.replace(/\/$/, "")}${webPath}` : "",
      childrenCount: page.children?.page?.size || 0,
    };
  } catch {
    return null;
  }
}

function buildPageContent(info: PageInfo): string {
  const parts: string[] = [];

  // Header with metadata
  const metaLines: string[] = [];
  if (info.spaceKey) metaLines.push(`**Space:** ${info.spaceKey}`);
  if (info.ancestors.length > 0) metaLines.push(`**Path:** ${info.ancestors.join(" > ")} > ${info.title}`);
  if (info.labels.length > 0) metaLines.push(`**Labels:** ${info.labels.join(", ")}`);
  if (info.createdBy) metaLines.push(`**Created by:** ${info.createdBy}`);
  if (info.updatedBy && info.updatedBy !== info.createdBy) metaLines.push(`**Last updated by:** ${info.updatedBy}`);
  if (info.createdAt) metaLines.push(`**Created:** ${info.createdAt.slice(0, 10)}`);
  if (info.updatedAt) metaLines.push(`**Updated:** ${info.updatedAt.slice(0, 10)}`);
  if (info.webUrl) metaLines.push(`**URL:** ${info.webUrl}`);

  if (metaLines.length > 0) {
    parts.push("[Page Metadata]");
    parts.push(metaLines.join("\n"));
    parts.push("");
  }

  parts.push("[Page Content]");
  parts.push(info.content);

  return parts.join("\n").trim();
}

export async function syncConfluence(
  sourceId: string,
  projectId: string,
  config: ConfluenceConfig,
) {
  const { baseUrl, email, apiToken, maxPages = 100 } = config;
  let indexed = 0;

  const pageIds: string[] = [...(config.pageIds || [])];

  if (config.spaceKey) {
    let start = 0;
    const limit = 25;

    while (pageIds.length < maxPages) {
      const res = await confluenceFetch(
        baseUrl,
        `/content?spaceKey=${config.spaceKey}&type=page&start=${start}&limit=${limit}`,
        email,
        apiToken,
      );

      const pages = res.results || [];
      if (pages.length === 0) break;

      for (const page of pages) {
        if (page?.id) pageIds.push(page.id);
        if (pageIds.length >= maxPages) break;
      }

      start += limit;
      if (pages.length < limit) break;
    }
  }

  for (const pageId of pageIds.slice(0, maxPages)) {
    const info = await fetchPageInfo(baseUrl, pageId, email, apiToken);
    if (!info || info.content.length < 10) continue;

    const fullContent = buildPageContent(info);

    const metadata: Record<string, any> = {
      source: "confluence",
      source_type: "confluence",
      pageId: info.id,
      spaceKey: info.spaceKey,
      url: info.webUrl,
      version: info.version,
      createdAt: info.createdAt || null,
      updatedAt: info.updatedAt || null,
      createdBy: info.createdBy || null,
      updatedBy: info.updatedBy || null,
      ancestors: info.ancestors,
      labels: info.labels,
      childrenCount: info.childrenCount,
    };

    // Synthesis per page
    const synthesis = await synthesizeDocument(fullContent, "web_docs", info.title, {
      url: info.webUrl,
      space: info.spaceKey,
      path: info.ancestors.length > 0 ? `${info.ancestors.join(" > ")} > ${info.title}` : info.title,
      ...(info.labels.length > 0 ? { labels: info.labels.join(", ") } : {}),
      ...(info.updatedAt ? { updated: info.updatedAt.slice(0, 10) } : {}),
    });

    if (synthesis) {
      const synthesisContent = formatSynthesis(synthesis, info.title);
      await ingestDocument({
        sourceId,
        projectId,
        externalId: `confluence-${pageId}#synthesis`,
        title: `${info.title} — Overview`,
        content: synthesisContent,
        metadata: { ...metadata, is_synthesis: true },
        webUrl: info.webUrl,
        sourceType: "confluence",
        ingestionProfile: "web_docs",
      });
    }

    await ingestDocument({
      sourceId,
      projectId,
      externalId: `confluence-${pageId}`,
      title: info.title,
      content: fullContent,
      metadata,
      webUrl: info.webUrl,
      sourceType: "confluence",
      ingestionProfile: "web_docs",
    });

    indexed++;
  }

  if (indexed > 0) {
    generateSourceProfile(sourceId, projectId, {
      sourceType: "confluence",
      rootUrl: baseUrl,
    }).catch(() => {});
  }

  return { pagesIndexed: indexed };
}
