import * as cheerio from "cheerio";
import { ingestDocument } from "../engine/ingest.js";
import { synthesizeDocument, formatSynthesis } from "../engine/synthesis.js";
import { generateSourceProfile } from "../engine/source-extraction.js";

interface ArxivConfig {
  query?: string;
  paperIds?: string[];
  maxResults?: number;
  /** Attempt to download and index the full paper PDF (default: true) */
  fetchFullText?: boolean;
}

interface ArxivPaper {
  id: string;
  title: string;
  summary: string;
  authors: string[];
  categories: string[];
  primaryCategory: string;
  url: string;
  pdfUrl: string;
  publishedAt: string;
  updatedAt: string;
  journalRef: string;
  doi: string;
  comment: string;
  license: string;
  links: Array<{ href: string; rel: string; type?: string }>;
}

export async function syncArxiv(
  sourceId: string,
  projectId: string,
  config: ArxivConfig,
) {
  const { maxResults = 20, fetchFullText = true } = config;
  let papers: ArxivPaper[] = [];

  if (config.paperIds?.length) {
    const ids = config.paperIds.join(",");
    const res = await fetch(
      `http://export.arxiv.org/api/query?id_list=${ids}&max_results=${config.paperIds.length}`,
    );
    if (!res.ok) throw new Error(`arXiv API error: ${res.status}`);
    papers = parseArxivResponse(await res.text());
  } else if (config.query) {
    const query = encodeURIComponent(config.query);
    const res = await fetch(
      `http://export.arxiv.org/api/query?search_query=all:${query}&max_results=${maxResults}&sortBy=relevance`,
    );
    if (!res.ok) throw new Error(`arXiv API error: ${res.status}`);
    papers = parseArxivResponse(await res.text());
  }

  let indexed = 0;

  for (const paper of papers) {
    // Fetch full-text PDF if available and enabled
    let fullText: string | null = null;
    if (fetchFullText && paper.pdfUrl) {
      fullText = await fetchArxivPdf(paper.pdfUrl);
    }

    // Build rich metadata document (always indexed)
    const metaContent = buildPaperContent(paper, fullText);

    // Generate synthesis for the full text or abstract
    const contentForSynthesis = fullText || `${paper.title}\n\nAuthors: ${paper.authors.join(", ")}\n\n${paper.summary}`;
    const synthesis = await synthesizeDocument(contentForSynthesis, "arxiv", paper.title, {
      authors: paper.authors.join(", "),
      categories: paper.categories.join(", "),
      published: paper.publishedAt,
      ...(paper.journalRef ? { journal: paper.journalRef } : {}),
      ...(paper.doi ? { doi: paper.doi } : {}),
      ...(paper.comment ? { note: paper.comment } : {}),
    });

    // Index synthesis document
    if (synthesis) {
      const synthesisContent = formatSynthesis(synthesis, paper.title);
      await ingestDocument({
        sourceId,
        projectId,
        externalId: `arxiv-${paper.id}#synthesis`,
        title: `${paper.title} — Overview`,
        content: synthesisContent,
        metadata: buildPaperMetadata(paper, { is_synthesis: true }),
        sourceType: "arxiv",
        ingestionProfile: "plain_text",
      });
    }

    // Index the rich metadata + full text document
    await ingestDocument({
      sourceId,
      projectId,
      externalId: `arxiv-${paper.id}`,
      title: paper.title,
      content: metaContent,
      metadata: buildPaperMetadata(paper, {}),
      sourceType: "arxiv",
      ingestionProfile: fullText ? "pdf_layout" : "plain_text",
    });

    // If full text is substantial, index separately for denser retrieval
    if (fullText && fullText.length > 2000) {
      await ingestDocument({
        sourceId,
        projectId,
        externalId: `arxiv-${paper.id}#fulltext`,
        title: `${paper.title} — Full Text`,
        content: fullText,
        metadata: buildPaperMetadata(paper, { is_full_text: true }),
        sourceType: "arxiv",
        ingestionProfile: "pdf_layout",
        skipEntityExtraction: false,
      });
    }

    indexed++;
  }

  if (indexed > 0) {
    generateSourceProfile(sourceId, projectId, { sourceType: "arxiv" }).catch(() => {});
  }

  return { papersIndexed: indexed };
}

function buildPaperContent(paper: ArxivPaper, fullText: string | null): string {
  const lines: string[] = [];

  lines.push(`# ${paper.title}`);
  lines.push("");

  // Authors
  if (paper.authors.length > 0) {
    lines.push(`**Authors:** ${paper.authors.join(", ")}`);
  }

  // Categories
  if (paper.categories.length > 0) {
    lines.push(`**Categories:** ${paper.categories.join(", ")}`);
    if (paper.primaryCategory) {
      lines.push(`**Primary Category:** ${paper.primaryCategory}`);
    }
  }

  // Dates
  if (paper.publishedAt) lines.push(`**Submitted:** ${paper.publishedAt}`);
  if (paper.updatedAt && paper.updatedAt !== paper.publishedAt) {
    lines.push(`**Last Revised:** ${paper.updatedAt}`);
  }

  // Journal / DOI
  if (paper.journalRef) lines.push(`**Journal:** ${paper.journalRef}`);
  if (paper.doi) lines.push(`**DOI:** ${paper.doi}`);
  if (paper.comment) lines.push(`**Note:** ${paper.comment}`);
  if (paper.license) lines.push(`**License:** ${paper.license}`);

  // Links
  lines.push(`**arXiv:** ${paper.url}`);
  if (paper.pdfUrl) lines.push(`**PDF:** ${paper.pdfUrl}`);

  lines.push("");
  lines.push("## Abstract");
  lines.push("");
  lines.push(paper.summary);

  if (fullText && fullText.length > 200) {
    lines.push("");
    lines.push("## Full Text");
    lines.push("");
    // Include the full text but trimmed to avoid massive duplication with the #fulltext doc
    lines.push(fullText.slice(0, 8000));
    if (fullText.length > 8000) {
      lines.push(`\n[... ${Math.round((fullText.length - 8000) / 1000)}k more characters in full text document]`);
    }
  }

  return lines.join("\n");
}

function buildPaperMetadata(paper: ArxivPaper, extra: Record<string, any>): Record<string, any> {
  return {
    source: "arxiv",
    source_type: "arxiv",
    paperId: paper.id,
    title: paper.title,
    authors: paper.authors,
    authorCount: paper.authors.length,
    categories: paper.categories,
    primaryCategory: paper.primaryCategory || null,
    url: paper.url,
    pdfUrl: paper.pdfUrl || null,
    publishedAt: paper.publishedAt || null,
    updatedAt: paper.updatedAt || null,
    journalRef: paper.journalRef || null,
    doi: paper.doi || null,
    comment: paper.comment || null,
    license: paper.license || null,
    ...extra,
  };
}

async function fetchArxivPdf(pdfUrl: string): Promise<string | null> {
  try {
    const res = await fetch(pdfUrl, {
      headers: { "User-Agent": "RetainDB-arxiv-indexer/1.0" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;

    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("application/pdf") && !pdfUrl.endsWith(".pdf")) return null;

    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.subarray(0, 5).toString("utf8") !== "%PDF-") return null;

    // Reuse the pdf-parse logic from the PDF connector
    try {
      const pdfParseModule = await import("pdf-parse");
      const pdfParse = (pdfParseModule as any).default || pdfParseModule;
      const pdf = await pdfParse(buffer);
      const text = String(pdf.text || "").replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
      return text.length > 100 ? text : null;
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}

function parseArxivResponse(xml: string): ArxivPaper[] {
  const $ = cheerio.load(xml, { xmlMode: true });
  const papers: ArxivPaper[] = [];

  $("entry").each((_, el) => {
    const idRaw = $(el).find("id").first().text().trim();
    // Extract paper ID from URL like http://arxiv.org/abs/2301.00001v2
    const id = idRaw.split("/abs/").pop()?.replace(/v\d+$/, "") || idRaw;
    const title = $(el).find("title").first().text().trim().replace(/\s+/g, " ");
    const summary = $(el).find("summary").first().text().trim().replace(/\s+/g, " ");

    const authors = $(el)
      .find("author name")
      .map((_, a) => $(a).text().trim())
      .get()
      .filter(Boolean);

    const categories = $(el)
      .find("category")
      .map((_, c) => $(c).attr("term") || "")
      .get()
      .filter(Boolean);

    const primaryCategory =
      $(el).find("arxiv\\:primary_category, primary_category").attr("term") ||
      categories[0] ||
      "";

    // Published / updated dates
    const publishedAt = $(el).find("published").first().text().trim();
    const updatedAt = $(el).find("updated").first().text().trim();

    // Optional fields
    const journalRef = $(el).find("arxiv\\:journal_ref, journal_ref").first().text().trim();
    const doi = $(el).find("arxiv\\:doi, doi").first().text().trim();
    const comment = $(el).find("arxiv\\:comment, comment").first().text().trim();
    const license = $(el).find("rights").first().text().trim();

    // Links
    const links: ArxivPaper["links"] = [];
    $(el)
      .find("link")
      .each((_, linkEl) => {
        const href = $(linkEl).attr("href") || "";
        const rel = $(linkEl).attr("rel") || "";
        const type = $(linkEl).attr("type") || undefined;
        if (href) links.push({ href, rel, type });
      });

    // Canonical arXiv page URL and PDF URL
    const absUrl = `https://arxiv.org/abs/${id}`;
    const pdfUrl = `https://arxiv.org/pdf/${id}`;

    papers.push({
      id,
      title,
      summary,
      authors,
      categories,
      primaryCategory,
      url: absUrl,
      pdfUrl,
      publishedAt,
      updatedAt,
      journalRef,
      doi,
      comment,
      license,
      links,
    });
  });

  return papers;
}
