import { ingestDocument } from "../engine/ingest.js";
import { synthesizeDocument, formatSynthesis } from "../engine/synthesis.js";
import { spawn } from "child_process";
import { promises as fs } from "fs";
import { tmpdir } from "os";
import { basename, join } from "path";
import { randomUUID } from "crypto";

interface PdfConfig {
  url?: string;
  file_path?: string;
  content?: string;
  title?: string;
  allow_ocr_fallback?: boolean;
  ocr_provider?: "local";
  profile_config?: Record<string, any>;
}

type ParsedPdfResult = {
  text: string | null;
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string;
  creator?: string;
  producer?: string;
  pageCount?: number;
  language?: string;
  document_date?: string;
  version?: string;
  ocr_applied?: boolean;
  ocr_provider?: string;
};

const PDF_OCR_MIN_TEXT_CHARS = Number(process.env.PDF_OCR_MIN_TEXT_CHARS || "200");

function formatMarkdownTable(table: string[][]): string {
  const rows = table
    .map((row) => row.map((cell) => String(cell || "").replace(/\s+/g, " ").trim()))
    .filter((row) => row.some(Boolean));
  if (rows.length === 0) return "";

  const header = rows[0];
  const body = rows.slice(1);
  const lines = [`| ${header.join(" | ")} |`];
  if (body.length > 0) {
    lines.push(`| ${header.map(() => "---").join(" | ")} |`);
    for (const row of body) {
      const padded = [...row];
      while (padded.length < header.length) padded.push("");
      lines.push(`| ${padded.join(" | ")} |`);
    }
  }
  return lines.join("\n");
}

function parsePdfDate(value: unknown): string | undefined {
  if (!value) return undefined;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }
  const raw = String(value).trim();
  if (!raw) return undefined;

  const direct = new Date(raw);
  if (!Number.isNaN(direct.getTime())) {
    return direct.toISOString();
  }

  const match = raw.match(
    /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/
  );
  if (!match) return undefined;

  const year = Number(match[1]);
  const month = Number(match[2] || "01") - 1;
  const day = Number(match[3] || "01");
  const hour = Number(match[4] || "00");
  const minute = Number(match[5] || "00");
  const second = Number(match[6] || "00");
  const parsed = new Date(Date.UTC(year, month, day, hour, minute, second));
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

async function tryPdfParse(buffer: Buffer): Promise<ParsedPdfResult | null> {
  try {
    const pdfParseModule = await import("pdf-parse");
    const pdfParse = (pdfParseModule as any).default || pdfParseModule;
    const pdf = await pdfParse(buffer);
    const info = (pdf as any)?.info || {};
    return {
      text: pdf.text || null,
      title: typeof info.Title === "string" && info.Title.trim() ? info.Title.trim() : undefined,
      author: typeof info.Author === "string" && info.Author.trim() ? info.Author.trim() : undefined,
      subject: typeof info.Subject === "string" && info.Subject.trim() ? info.Subject.trim() : undefined,
      keywords: typeof info.Keywords === "string" && info.Keywords.trim() ? info.Keywords.trim() : undefined,
      creator: typeof info.Creator === "string" && info.Creator.trim() ? info.Creator.trim() : undefined,
      producer: typeof info.Producer === "string" && info.Producer.trim() ? info.Producer.trim() : undefined,
      pageCount: typeof pdf.numpages === "number" ? pdf.numpages : undefined,
      language: typeof info.Language === "string" && info.Language.trim() ? info.Language.trim() : undefined,
      document_date: parsePdfDate(info.ModDate) || parsePdfDate(info.CreationDate),
      version:
        typeof info.PDFFormatVersion === "string" && info.PDFFormatVersion.trim()
          ? info.PDFFormatVersion.trim()
          : undefined,
    };
  } catch (e) {
    return null;
  }
}

async function tryStructuredPdfParse(buffer: Buffer): Promise<ParsedPdfResult | null> {
  let parser: any;
  try {
    const pdfParseModule = await import("pdf-parse");
    const PDFParse = (pdfParseModule as any).PDFParse;
    if (!PDFParse) return null;

    parser = new PDFParse({ data: buffer });
    const info = await parser.getInfo({ parsePageInfo: true });
    const text = await parser.getText({
      lineEnforce: true,
      cellSeparator: " | ",
    });

    let tablesByPage = new Map<number, string[]>();
    try {
      const tableResult = await parser.getTable();
      tablesByPage = new Map(
        (tableResult?.pages || []).map((page: any) => [
          page.num,
          (page.tables || [])
            .map((table: string[][]) => formatMarkdownTable(table))
            .filter(Boolean),
        ])
      );
    } catch {
      // Table detection is best-effort. Text extraction should still succeed.
    }

    const pageInfoByNum = new Map(
      (info?.pages || []).map((page: any) => [page.pageNumber, page])
    );
    const contentParts: string[] = [];

    for (const page of text.pages || []) {
      const pageInfo = pageInfoByNum.get(page.num) as any;
      const pageLabel = pageInfo?.pageLabel ? String(pageInfo.pageLabel) : `${page.num}`;
      const pageText = String(page.text || "").trim();
      const pageTables = tablesByPage.get(page.num) || [];

      contentParts.push(`--- Page ${page.num} ---`);
      contentParts.push(`# Page ${pageLabel}`);
      if (pageText) contentParts.push(pageText);
      if (pageTables.length > 0) {
        contentParts.push("## Tables");
        pageTables.forEach((table, index) => {
          contentParts.push(`### Table ${index + 1}`);
          contentParts.push(table);
        });
      }
    }

    const dateNode = typeof info?.getDateNode === "function" ? info.getDateNode() : {};
    return {
      text: contentParts.join("\n\n").trim() || text.text || null,
      title:
        (typeof info?.info?.Title === "string" && info.info.Title.trim()) ||
        undefined,
      document_date:
        parsePdfDate(dateNode?.ModDate) ||
        parsePdfDate(dateNode?.CreationDate) ||
        parsePdfDate(info?.info?.ModDate) ||
        parsePdfDate(info?.info?.CreationDate),
      version:
        (typeof info?.info?.PDFFormatVersion === "string" && info.info.PDFFormatVersion.trim()) ||
        undefined,
    };
  } catch {
    return null;
  } finally {
    if (parser?.destroy) {
      await parser.destroy().catch(() => undefined);
    }
  }
}

function shouldTryOcr(parsed: ParsedPdfResult | null, config: PdfConfig): boolean {
  const allowFallback =
    config.allow_ocr_fallback === true ||
    config.profile_config?.ocr?.ocr_fallback === true ||
    /^true$/i.test(process.env.PDF_OCR_FALLBACK || "false");
  const textLength = String(parsed?.text || "").replace(/\s+/g, "").length;
  return allowFallback && textLength < PDF_OCR_MIN_TEXT_CHARS;
}

async function runProcess(command: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", () => resolve({ stdout, stderr, code: -1 }));
    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? -1 }));
  });
}

async function commandAvailable(command: string, args: string[]): Promise<boolean> {
  const result = await runProcess(command, args);
  return result.code === 0 || (result.code === 1 && (result.stdout.length > 0 || result.stderr.length > 0));
}

async function tryCliOcrPdf(buffer: Buffer): Promise<ParsedPdfResult | null> {
  const hasPdftoppm = await commandAvailable("pdftoppm", ["-h"]);
  const hasTesseract = await commandAvailable("tesseract", ["--version"]);
  if (!hasPdftoppm || !hasTesseract) return null;

  const workingDir = join(tmpdir(), `whisper-pdf-ocr-${randomUUID()}`);
  await fs.mkdir(workingDir, { recursive: true });
  const pdfPath = join(workingDir, "input.pdf");
  const imagePrefix = join(workingDir, "page");

  try {
    await fs.writeFile(pdfPath, buffer);
    const render = await runProcess("pdftoppm", ["-png", "-r", "150", pdfPath, imagePrefix]);
    if (render.code !== 0) return null;

    const files = (await fs.readdir(workingDir))
      .filter((file) => /^page-\d+\.png$/i.test(file))
      .sort((a, b) => {
        const left = Number(a.match(/(\d+)/)?.[1] || 0);
        const right = Number(b.match(/(\d+)/)?.[1] || 0);
        return left - right;
      });

    const pages: string[] = [];
    for (const [index, file] of files.entries()) {
      const imagePath = join(workingDir, file);
      const ocr = await runProcess("tesseract", [imagePath, "stdout", "--psm", "6"]);
      if (ocr.code !== 0) continue;
      const text = ocr.stdout.replace(/\r\n/g, "\n").trim();
      if (!text) continue;
      pages.push(`--- Page ${index + 1} ---\n${text}`);
    }

    if (pages.length === 0) return null;
    return {
      text: pages.join("\n\n"),
      ocr_applied: true,
      ocr_provider: "local",
    };
  } catch {
    return null;
  } finally {
    await fs.rm(workingDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function looksLikePdfBuffer(buffer: Buffer): boolean {
  return buffer.subarray(0, 5).toString("utf8") === "%PDF-";
}

interface PostProcessOptions {
  author?: string;
  subject?: string;
  keywords?: string;
  pageCount?: number;
  documentDate?: string;
}

/**
 * Post-process raw pdf-parse output:
 * 1. Prepend a document header (title, author, date, keywords)
 * 2. Remove repeated header/footer lines (appear on >30% of pages)
 * 3. Detect section headings from text patterns and add markdown prefixes
 * 4. Clean up common PDF extraction artifacts
 */
function postProcessPdfText(text: string, title: string, opts: PostProcessOptions): string {
  // Split into pages by our page markers
  const pagePattern = /^--- Page \d+ ---$/m;
  const rawPages = text.split(/(?=^--- Page \d+ ---$)/m).filter((p) => p.trim());

  if (rawPages.length === 0) return text;

  // Extract per-page lines (excluding the page marker itself)
  const pageLines: string[][] = rawPages.map((page) =>
    page
      .split("\n")
      .filter((line) => !pagePattern.test(line.trim()))
      .map((line) => line.trim())
      .filter(Boolean),
  );

  // Detect repeated header/footer lines (appear on >30% of pages, up to first/last 3 lines)
  const totalPages = pageLines.length;
  const threshold = Math.max(2, Math.floor(totalPages * 0.3));
  const lineFreq = new Map<string, number>();

  for (const lines of pageLines) {
    // Check first 3 and last 3 lines of each page
    const candidates = [
      ...lines.slice(0, 3),
      ...lines.slice(-3),
    ];
    const seen = new Set<string>();
    for (const line of candidates) {
      if (line.length < 5 || line.length > 120) continue;
      if (seen.has(line)) continue;
      seen.add(line);
      lineFreq.set(line, (lineFreq.get(line) || 0) + 1);
    }
  }

  const boilerplateLines = new Set(
    [...lineFreq.entries()]
      .filter(([, freq]) => freq >= threshold)
      .map(([line]) => line),
  );

  // Rebuild with heading detection and boilerplate removal
  const headingPattern = /^(\d+\.)+\s+\w/; // "1.2.3 Section Name"
  const allCapsPattern = /^[A-Z][A-Z0-9 ,\-:]{3,60}$/;
  const titleCasePattern = /^(?:[A-Z][a-z]+\s+){1,8}[A-Z][a-z]+$/;

  const cleanedPages: string[] = [];

  for (let i = 0; i < rawPages.length; i++) {
    const pageMarkerMatch = rawPages[i].match(/^--- Page (\d+) ---/m);
    const pageNum = pageMarkerMatch ? pageMarkerMatch[1] : String(i + 1);
    const lines = pageLines[i];

    const cleanLines: string[] = [`--- Page ${pageNum} ---`];

    for (let j = 0; j < lines.length; j++) {
      const line = lines[j];

      // Remove boilerplate (repeated header/footer)
      if (boilerplateLines.has(line)) continue;

      // Remove bare page numbers: "1", "- 2 -", "Page 3"
      if (/^-?\s*Page\s*\d+\s*-?$/i.test(line) || /^-?\s*\d+\s*-?$/.test(line)) continue;

      // Detect section headings and add markdown prefix
      if (headingPattern.test(line) && line.length < 100) {
        const depth = (line.match(/\./g) || []).length;
        cleanLines.push(`${"#".repeat(Math.min(depth + 1, 4))} ${line}`);
        continue;
      }

      // ALL CAPS short lines are likely section titles
      if (allCapsPattern.test(line) && line.length < 60) {
        cleanLines.push(`## ${line}`);
        continue;
      }

      // Title case short lines preceded by blank / heading context
      if (titleCasePattern.test(line) && line.length < 60 && j < lines.length - 1) {
        cleanLines.push(`### ${line}`);
        continue;
      }

      cleanLines.push(line);
    }

    cleanedPages.push(cleanLines.join("\n"));
  }

  // Prepend document header
  const headerLines: string[] = [`# ${title}`];
  if (opts.author) headerLines.push(`**Author:** ${opts.author}`);
  if (opts.subject) headerLines.push(`**Subject:** ${opts.subject}`);
  if (opts.keywords) headerLines.push(`**Keywords:** ${opts.keywords}`);
  if (opts.documentDate) headerLines.push(`**Date:** ${opts.documentDate.slice(0, 10)}`);
  if (opts.pageCount) headerLines.push(`**Pages:** ${opts.pageCount}`);
  headerLines.push("");

  return (
    headerLines.join("\n") +
    "\n" +
    cleanedPages.join("\n\n").replace(/\n{3,}/g, "\n\n").trim()
  );
}

export async function syncPdf(
  sourceId: string,
  projectId: string,
  config: PdfConfig
) {
  let resolvedTitle = config.title || "PDF Document";

  let textContent = "";
  let documentDate: string | undefined;
  let version: string | undefined;
  let ocrApplied = false;
  let ocrProvider: string | undefined;
  let pdfAuthor: string | undefined;
  let pdfSubject: string | undefined;
  let pdfKeywords: string | undefined;
  let pdfCreator: string | undefined;
  let pdfProducer: string | undefined;
  let pdfPageCount: number | undefined;
  let pdfLanguage: string | undefined;

  const finalizeParsedPdf = async (buffer: Buffer, parsedPdf: ParsedPdfResult | null) => {
    let effective = parsedPdf;
    if (shouldTryOcr(parsedPdf, config)) {
      const ocrPdf = await tryCliOcrPdf(buffer);
      if (ocrPdf?.text) {
        effective = {
          ...parsedPdf,
          ...ocrPdf,
          text: ocrPdf.text,
        };
      }
    }

    if (!effective) return false;
    textContent = effective.text || "";
    resolvedTitle = config.title || effective.title || resolvedTitle;
    documentDate = effective.document_date;
    version = effective.version;
    ocrApplied = Boolean(effective.ocr_applied);
    ocrProvider = effective.ocr_provider;
    pdfAuthor = effective.author;
    pdfSubject = effective.subject;
    pdfKeywords = effective.keywords;
    pdfCreator = effective.creator;
    pdfProducer = effective.producer;
    pdfPageCount = effective.pageCount;
    pdfLanguage = effective.language;
    return true;
  };

  if (config.file_path) {
    const buffer = await fs.readFile(config.file_path);
    const parsedPdf = await tryStructuredPdfParse(buffer) || await tryPdfParse(buffer);
    const handled = await finalizeParsedPdf(buffer, parsedPdf);
    if (!handled) {
      throw new Error(
        `PDF parsing failed for file_path '${config.file_path}'.`
      );
    }
    resolvedTitle = config.title || resolvedTitle || basename(config.file_path);
  } else if (config.url) {
    const res = await fetch(config.url, {
      headers: { "User-Agent": "whisper-context-bot" },
      signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) throw new Error(`Failed to fetch PDF: ${res.status}`);

    const contentType = res.headers.get("content-type") || "";
    const disposition = res.headers.get("content-disposition") || "";
    const urlLooksLikePdf = /\.pdf(?:$|[?#])/i.test(config.url);

    if (contentType.includes("text/html") || contentType.includes("text/plain")) {
      textContent = await res.text();
    } else {
      const buffer = Buffer.from(await res.arrayBuffer());
      if (
        contentType.includes("application/pdf") ||
        disposition.toLowerCase().includes(".pdf") ||
        urlLooksLikePdf ||
        looksLikePdfBuffer(buffer)
      ) {
        const parsedPdf = await tryStructuredPdfParse(buffer) || await tryPdfParse(buffer);
        const handled = await finalizeParsedPdf(buffer, parsedPdf);
        if (!handled) {
          throw new Error(
            "PDF parsing failed. Install pdf-parse: npm install pdf-parse"
          );
        }
      } else if (contentType.includes("text/")) {
        textContent = buffer.toString("utf8");
      } else {
        throw new Error(`Unsupported PDF content type: ${contentType || "unknown"}`);
      }
    }
  } else if (config.content) {
    const buffer = Buffer.from(config.content, "base64");
    const parsedPdf = await tryStructuredPdfParse(buffer) || await tryPdfParse(buffer);
    const handled = await finalizeParsedPdf(buffer, parsedPdf);
    if (!handled) {
      throw new Error(
        "PDF parsing failed. Install pdf-parse: npm install pdf-parse"
      );
    }
  }

  if (!textContent || textContent.length < 10) {
    throw new Error("No text content could be extracted from the PDF");
  }

  if (!/^--- Page \d+ ---$/im.test(textContent)) {
    const pages = textContent.split("\f").map((page) => page.trim()).filter(Boolean);
    textContent = (pages.length > 0 ? pages : [textContent])
      .map((page, index) => `--- Page ${index + 1} ---\n${page}`)
      .join("\n\n");
  }

  textContent = textContent
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  // Post-process: remove header/footer noise, detect section headings
  textContent = postProcessPdfText(textContent, resolvedTitle, {
    author: pdfAuthor,
    subject: pdfSubject,
    keywords: pdfKeywords,
    pageCount: pdfPageCount,
    documentDate,
  });

  const externalId = config.url || config.file_path || `pdf-${resolvedTitle}`;
  const pdfMeta: Record<string, any> = {
    source: "pdf",
    source_type: "pdf",
    url: config.url || null,
    file_path: config.file_path || null,
    characterCount: textContent.length,
    ...(documentDate ? { document_date: documentDate } : {}),
    ...(version ? { pdf_version: version } : {}),
    ...(ocrApplied ? { ocr_applied: true, ocr_provider: ocrProvider || "local" } : {}),
    ...(pdfAuthor ? { author: pdfAuthor } : {}),
    ...(pdfSubject ? { subject: pdfSubject } : {}),
    ...(pdfKeywords ? { keywords: pdfKeywords } : {}),
    ...(pdfCreator ? { creator_app: pdfCreator } : {}),
    ...(pdfProducer ? { producer_app: pdfProducer } : {}),
    ...(pdfPageCount ? { page_count: pdfPageCount } : {}),
    ...(pdfLanguage ? { language: pdfLanguage } : {}),
  };

  // Generate LLM synthesis — comprehensive, structured overview
  const synthesis = await synthesizeDocument(textContent, "pdf", resolvedTitle, {
    source: config.url || config.file_path || "uploaded content",
    ...(documentDate ? { date: documentDate } : {}),
    ...(pdfAuthor ? { author: pdfAuthor } : {}),
    ...(pdfSubject ? { subject: pdfSubject } : {}),
    ...(pdfKeywords ? { keywords: pdfKeywords } : {}),
    ...(pdfPageCount ? { pages: String(pdfPageCount) } : {}),
  });

  if (synthesis) {
    const synthesisContent = formatSynthesis(synthesis, resolvedTitle);
    await ingestDocument({
      sourceId,
      projectId,
      externalId: `${externalId}#synthesis`,
      title: `${resolvedTitle} — Overview`,
      content: synthesisContent,
      metadata: { ...pdfMeta, is_synthesis: true },
      sourceType: "pdf",
      ingestionProfile: "pdf_layout",
    });
  }

  // Index the full text content
  await ingestDocument({
    sourceId,
    projectId,
    externalId,
    title: resolvedTitle,
    content: textContent,
    metadata: pdfMeta,
    sourceType: "pdf",
    ingestionProfile: "pdf_layout",
    profileConfig: config.profile_config as any,
  });

  return {
    documentsIndexed: synthesis ? 2 : 1,
    characterCount: textContent.length,
    synthesisGenerated: Boolean(synthesis),
  };
}
