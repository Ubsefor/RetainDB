import { readFileSync, statSync } from "node:fs";
import { basename, extname, resolve as resolvePath } from "node:path";
import { gunzipSync } from "node:zlib";
import { ingestDocument } from "../engine/ingest.js";
import { synthesizeDocument, formatSynthesis } from "../engine/synthesis.js";
import { generateSourceProfile } from "../engine/source-extraction.js";

type SyncProgress = { current: number; total: number; message: string };

export interface DatasetConfig {
  url?: string;
  file_path?: string;
  format?: "csv" | "tsv" | "jsonl" | "json";
  compression?: "gzip";
  delimiter?: string;
  id_column?: string;
  text_columns?: string[];
  max_rows?: number;
  rows_per_document?: number;
  max_bytes?: number;
  encoding?: BufferEncoding;
  metadata?: Record<string, any>;
}

const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_ROWS = 20_000;
const DEFAULT_ROWS_PER_DOC = 200;
const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

export async function syncDataset(
  sourceId: string,
  projectId: string,
  config: DatasetConfig,
  onProgress?: (progress: SyncProgress) => void,
  signal?: AbortSignal
) {
  const maxBytes = Math.max(1024 * 1024, Number(config.max_bytes || DEFAULT_MAX_BYTES));
  const maxRows = Math.max(1, Number(config.max_rows || DEFAULT_MAX_ROWS));
  const rowsPerDoc = Math.min(2000, Math.max(1, Number(config.rows_per_document || DEFAULT_ROWS_PER_DOC)));
  const encoding = (config.encoding || "utf8") as BufferEncoding;

  if (!config.url && !config.file_path) {
    throw new Error("dataset requires url or file_path");
  }

  const datasetHint = config.url
    ? safeBasenameFromUrl(config.url)
    : basename(String(config.file_path || "dataset"));
  const format = (config.format || inferFormat(datasetHint) || inferFormat(config.url) || inferFormat(config.file_path)) as
    | DatasetConfig["format"]
    | undefined;
  if (!format) {
    throw new Error("dataset format could not be inferred; set config.format to csv|tsv|jsonl|json");
  }

  onProgress?.({ current: 0, total: 0, message: "Loading dataset..." });

  const rawBytes = config.url
    ? await fetchBytes(config.url, { maxBytes, timeoutMs: DEFAULT_FETCH_TIMEOUT_MS, signal })
    : readLocalDatasetBytes(String(config.file_path), { maxBytes });

  const decompressedBytes = maybeGunzipBytes(rawBytes, {
    hint: datasetHint,
    explicit: config.compression,
  });
  const rawText = Buffer.from(decompressedBytes).toString(encoding);

  onProgress?.({ current: 0, total: 0, message: `Parsing ${format.toUpperCase()}...` });

  const parsed = parseDataset(rawText, { format, delimiter: config.delimiter, maxRows });
  const datasetName =
    String(config.metadata?.dataset_name || config.metadata?.name || "").trim() ||
    stripKnownExtensions(datasetHint) ||
    "dataset";

  const filePathForTyping = config.file_path
    ? String(config.file_path)
    : datasetHint.includes(".")
      ? datasetHint
      : `${datasetName}.${format}`;

  const baseMetadata = {
    ...(config.metadata || {}),
    source_type: "dataset",
    source_family: "plain_text",
    dataset_name: datasetName,
    dataset_format: format,
    dataset_columns: parsed.columns,
    dataset_id_column: config.id_column || null,
  };

  // Compute column stats for enriched overview
  const colStats = computeColumnStats(parsed.columns, parsed.rows);

  const overviewContent = renderDatasetOverviewMarkdown({
    datasetName,
    format,
    columns: parsed.columns,
    rowCount: parsed.rows.length,
    sampleRows: parsed.rows.slice(0, Math.min(5, parsed.rows.length)),
    colStats,
  });

  // Synthesis for the overview
  const synthesis = await synthesizeDocument(overviewContent, "dataset", `Dataset: ${datasetName}`, {
    format,
    rows: String(parsed.rows.length),
    columns: String(parsed.columns.length),
  });

  if (synthesis) {
    const synthesisContent = formatSynthesis(synthesis, `Dataset: ${datasetName}`);
    await ingestDocument({
      sourceId,
      projectId,
      externalId: "dataset-overview#synthesis",
      title: `Dataset: ${datasetName} — Overview`,
      content: synthesisContent,
      metadata: { ...baseMetadata, content_kind: "dataset_synthesis", is_synthesis: true },
      filePath: filePathForTyping,
      sourceType: "dataset",
    });
  }

  // Overview document: schema + sample + stats
  await ingestDocument({
    sourceId,
    projectId,
    externalId: "dataset-overview",
    title: `Dataset: ${datasetName}`,
    content: overviewContent,
    metadata: { ...baseMetadata, content_kind: "dataset_overview" },
    filePath: filePathForTyping,
    sourceType: "dataset",
  });

  // Row chunks: pack rows into documents but keep 1 row per Markdown section.
  const totalRows = parsed.rows.length;
  const docCount = Math.max(1, Math.ceil(totalRows / rowsPerDoc));
  onProgress?.({ current: 0, total: totalRows, message: `Indexing ${totalRows} rows...` });

  let documentsIndexed = 1;
  for (let docIndex = 0; docIndex < docCount; docIndex++) {
    const start = docIndex * rowsPerDoc;
    const end = Math.min(totalRows, start + rowsPerDoc);
    const rows = parsed.rows.slice(start, end);

    const content = renderDatasetRowsMarkdown({
      datasetName,
      idColumn: config.id_column,
      textColumns: config.text_columns,
      columns: parsed.columns,
      rows,
      rowOffset: start,
    });

    await ingestDocument({
      sourceId,
      projectId,
      externalId: `dataset-rows-${docIndex}`,
      title: `Dataset: ${datasetName} (rows ${start + 1}-${end})`,
      content,
      metadata: { ...baseMetadata, content_kind: "dataset_rows", row_start: start, row_end: end },
      filePath: filePathForTyping,
      sourceType: "dataset",
    });
    documentsIndexed += 1;
    onProgress?.({ current: end, total: totalRows, message: `Indexed ${end}/${totalRows} rows` });
  }

  generateSourceProfile(sourceId, projectId, {
    sourceType: "dataset",
    rootUrl: config.url || `file://${config.file_path || datasetName}`,
  }).catch(() => {});

  return {
    documentsIndexed,
    documentsTotal: documentsIndexed,
    rowsIndexed: totalRows,
    columns: parsed.columns,
  };
}

function stripKnownExtensions(name: string): string {
  return name.replace(/\.(csv|tsv|jsonl|ndjson|json)(\.gz)?$/i, "");
}

function safeBasenameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const last = u.pathname.split("/").filter(Boolean).pop();
    if (!last) return "dataset";
    return last;
  } catch {
    return "dataset";
  }
}

function inferFormat(hint?: string | null): DatasetConfig["format"] | null {
  if (!hint) return null;
  const raw = String(hint);
  const lower = raw.toLowerCase();
  if (lower.endsWith(".gz")) {
    const inner = raw.slice(0, -3);
    return inferFormat(inner);
  }
  const ext = extname(lower);
  if (ext === ".csv") return "csv";
  if (ext === ".tsv") return "tsv";
  if (ext === ".jsonl" || ext === ".ndjson") return "jsonl";
  if (ext === ".json") return "json";
  return null;
}

function maybeGunzipBytes(
  rawBytes: Uint8Array,
  opts: { hint?: string; explicit?: DatasetConfig["compression"] }
): Uint8Array {
  const should =
    opts.explicit === "gzip" ||
    (opts.explicit === undefined && typeof opts.hint === "string" && opts.hint.toLowerCase().endsWith(".gz"));
  if (!should) return rawBytes;
  try {
    return gunzipSync(rawBytes);
  } catch (error: any) {
    throw new Error(`dataset gzip decompression failed: ${error?.message || String(error)}`);
  }
}

function readLocalDatasetBytes(filePath: string, opts: { maxBytes: number }): Uint8Array {
  const resolved = resolvePath(filePath);
  const gate = isLocalPathAllowed(resolved);
  if (!gate.allowed) {
    throw new Error(`file_path not allowed by RETAINDB_LOCAL_ALLOWLIST. Allowed roots: ${gate.allowlist.join(", ")}`);
  }
  if (shouldSkipSensitivePath(resolved)) {
    throw new Error("file_path points to a denied/sensitive path");
  }

  const size = statSync(resolved).size;
  if (size > opts.maxBytes) {
    throw new Error(`dataset file too large (${size} bytes); max_bytes=${opts.maxBytes}`);
  }
  return readFileSync(resolved);
}

function getAllowlistRoots(): string[] {
  const allowlist = (process.env.RETAINDB_LOCAL_ALLOWLIST || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return allowlist.length > 0 ? allowlist : [process.cwd()];
}

function isLocalPathAllowed(targetPath: string): { allowed: boolean; allowlist: string[] } {
  const normalized = targetPath.replace(/\\/g, "/").toLowerCase();
  const allowlist = getAllowlistRoots();
  const allowed = allowlist.some((root) => normalized.startsWith(root.replace(/\\/g, "/").toLowerCase()));
  return { allowed, allowlist };
}

function shouldSkipSensitivePath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/").toLowerCase();
  const denySnippets = [
    "/node_modules/",
    "/.git/",
    "/dist/",
    "/build/",
    "/.next/",
    "/.aws/",
    "/.ssh/",
    ".pem",
    ".key",
    ".env",
    "credentials",
  ];
  return denySnippets.some((snippet) => normalized.includes(snippet));
}

async function fetchBytes(
  url: string,
  opts: { maxBytes: number; timeoutMs: number; signal?: AbortSignal }
): Promise<Uint8Array> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs);

  const chainedSignal = opts.signal ? anySignal([opts.signal, controller.signal]) : controller.signal;

  try {
    const res = await fetch(url, { signal: chainedSignal });
    if (!res.ok) throw new Error(`dataset fetch failed: ${res.status} ${res.statusText}`);
    const len = Number(res.headers.get("content-length") || "0");
    if (len && len > opts.maxBytes) {
      throw new Error(`dataset url too large (${len} bytes); max_bytes=${opts.maxBytes}`);
    }
    const bytes = await readStreamWithLimit(res.body, opts.maxBytes, chainedSignal);
    return bytes;
  } finally {
    clearTimeout(timeout);
  }
}

function anySignal(signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  for (const signal of signals) {
    if (signal.aborted) return signal;
    signal.addEventListener("abort", onAbort, { once: true });
  }
  return controller.signal;
}

async function readStreamWithLimit(
  body: any,
  maxBytes: number,
  signal?: AbortSignal
): Promise<Uint8Array> {
  if (!body) {
    return new Uint8Array();
  }

  const chunks: Uint8Array[] = [];
  let received = 0;

  // WHATWG ReadableStream (Node fetch)
  if (typeof body.getReader === "function") {
    const reader = body.getReader();
    while (true) {
      if (signal?.aborted) throw new Error("SYNC_ABORTED");
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value as Uint8Array;
      received += chunk.byteLength;
      if (received > maxBytes) throw new Error(`dataset body too large; max_bytes=${maxBytes}`);
      chunks.push(chunk);
    }
  } else if (typeof body[Symbol.asyncIterator] === "function") {
    for await (const value of body as AsyncIterable<Uint8Array>) {
      if (signal?.aborted) throw new Error("SYNC_ABORTED");
      const chunk = value as Uint8Array;
      received += chunk.byteLength;
      if (received > maxBytes) throw new Error(`dataset body too large; max_bytes=${maxBytes}`);
      chunks.push(chunk);
    }
  } else {
    // Fallback: try arrayBuffer
    const buf = new Uint8Array(await body.arrayBuffer());
    if (buf.byteLength > maxBytes) throw new Error(`dataset body too large; max_bytes=${maxBytes}`);
    return buf;
  }

  return concatBytes(chunks, received);
}

function concatBytes(chunks: Uint8Array[], total: number): Uint8Array {
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

function parseDataset(
  rawText: string,
  opts: { format: NonNullable<DatasetConfig["format"]>; delimiter?: string; maxRows: number }
): { columns: string[]; rows: Array<Record<string, any>> } {
  if (opts.format === "csv" || opts.format === "tsv") {
    const delimiter = opts.delimiter || (opts.format === "tsv" ? "\t" : ",");
    const { columns, rows } = parseDelimited(rawText, { delimiter, maxRows: opts.maxRows });
    return { columns, rows };
  }

  if (opts.format === "jsonl") {
    const rows = parseJsonl(rawText, { maxRows: opts.maxRows });
    const columns = collectColumns(rows);
    return { columns, rows };
  }

  // json: accept array of objects, or a single object.
  const json = JSON.parse(rawText);
  const rows: Array<Record<string, any>> = [];
  if (Array.isArray(json)) {
    for (const entry of json) {
      if (rows.length >= opts.maxRows) break;
      rows.push(typeof entry === "object" && entry ? entry : { value: entry });
    }
  } else if (typeof json === "object" && json) {
    rows.push(json);
  } else {
    rows.push({ value: json });
  }
  const columns = collectColumns(rows);
  return { columns, rows };
}

function collectColumns(rows: Array<Record<string, any>>): string[] {
  const columns = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row || {})) columns.add(key);
  }
  return Array.from(columns).slice(0, 500);
}

function parseJsonl(rawText: string, opts: { maxRows: number }): Array<Record<string, any>> {
  const rows: Array<Record<string, any>> = [];
  const lines = rawText.split(/\r?\n/);
  for (const line of lines) {
    if (rows.length >= opts.maxRows) break;
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      rows.push(typeof obj === "object" && obj ? obj : { value: obj });
    } catch {
      // Skip malformed lines rather than failing the entire dataset
    }
  }
  return rows;
}

function parseDelimited(
  rawText: string,
  opts: { delimiter: string; maxRows: number }
): { columns: string[]; rows: Array<Record<string, any>> } {
  const lines = rawText.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { columns: [], rows: [] };

  const header = splitDelimitedLine(lines[0], opts.delimiter);
  const columns = header.map((c, i) => (c?.trim() ? c.trim() : `col_${i + 1}`)).slice(0, 500);

  const rows: Array<Record<string, any>> = [];
  for (let i = 1; i < lines.length; i++) {
    if (rows.length >= opts.maxRows) break;
    const values = splitDelimitedLine(lines[i], opts.delimiter);
    const row: Record<string, any> = {};
    for (let c = 0; c < columns.length; c++) {
      row[columns[c]] = values[c] ?? "";
    }
    rows.push(row);
  }

  return { columns, rows };
}

function splitDelimitedLine(line: string, delimiter: string): string[] {
  // Minimal CSV/TSV parser with quote handling.
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "\"") {
      const next = line[i + 1];
      if (inQuotes && next === "\"") {
        cur += "\"";
        i++;
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && ch === delimiter) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

type ColType = "number" | "boolean" | "date" | "categorical" | "text";

interface ColStat {
  type: ColType;
  nullPct: number;
  cardinality: number;
  // numeric only
  min?: number;
  max?: number;
  mean?: number;
  // categorical only (up to 10 unique values)
  topValues?: string[];
}

function inferColType(values: any[]): ColType {
  const nonNull = values.filter((v) => v !== null && v !== undefined && v !== "");
  if (nonNull.length === 0) return "text";

  const sample = nonNull.slice(0, 200);

  // Boolean
  const boolSet = new Set(["true", "false", "yes", "no", "1", "0"]);
  if (sample.every((v) => boolSet.has(String(v).toLowerCase().trim()))) return "boolean";

  // Number
  if (sample.every((v) => !isNaN(Number(v)) && String(v).trim() !== "")) return "number";

  // Date: ISO or common date patterns
  const dateRe = /^\d{4}-\d{2}-\d{2}|^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/;
  if (sample.every((v) => dateRe.test(String(v).trim()))) return "date";

  // Categorical: low cardinality relative to count
  const unique = new Set(sample.map((v) => String(v).trim())).size;
  if (unique <= 20 && unique / sample.length < 0.3) return "categorical";

  return "text";
}

function computeColumnStats(columns: string[], rows: Array<Record<string, any>>): Map<string, ColStat> {
  const stats = new Map<string, ColStat>();
  const cap = Math.min(rows.length, 2000);
  const subset = rows.slice(0, cap);

  for (const col of columns.slice(0, 100)) {
    const values = subset.map((r) => r[col]);
    const nonNull = values.filter((v) => v !== null && v !== undefined && v !== "");
    const nullPct = Math.round((1 - nonNull.length / Math.max(1, values.length)) * 100);
    const unique = new Set(nonNull.map((v) => String(v).trim()));
    const type = inferColType(nonNull);

    const stat: ColStat = { type, nullPct, cardinality: unique.size };

    if (type === "number") {
      const nums = nonNull.map(Number).filter((n) => !isNaN(n));
      if (nums.length > 0) {
        stat.min = Math.min(...nums);
        stat.max = Math.max(...nums);
        stat.mean = Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 100) / 100;
      }
    } else if (type === "categorical") {
      // Count frequency
      const freq = new Map<string, number>();
      for (const v of nonNull) {
        const k = String(v).trim();
        freq.set(k, (freq.get(k) || 0) + 1);
      }
      stat.topValues = [...freq.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([k]) => k);
    }

    stats.set(col, stat);
  }

  return stats;
}

function renderDatasetOverviewMarkdown(params: {
  datasetName: string;
  format: string;
  columns: string[];
  rowCount: number;
  sampleRows: Array<Record<string, any>>;
  colStats?: Map<string, ColStat>;
}): string {
  const lines: string[] = [
    `# Dataset: ${params.datasetName}`,
    ``,
    `**Format:** \`${params.format}\`  `,
    `**Rows indexed:** \`${params.rowCount}\`  `,
    `**Columns:** \`${params.columns.length}\``,
    ``,
    `## Column Schema`,
  ];

  const displayCols = params.columns.slice(0, 200);
  for (const col of displayCols) {
    const stat = params.colStats?.get(col);
    if (stat) {
      let detail = `type=${stat.type}`;
      if (stat.nullPct > 0) detail += `, ${stat.nullPct}% null`;
      if (stat.type === "number" && stat.min !== undefined) {
        detail += `, min=${stat.min}, max=${stat.max}, mean=${stat.mean}`;
      } else if (stat.type === "categorical" && stat.topValues?.length) {
        detail += `, values: ${stat.topValues.slice(0, 5).join(" | ")}`;
      } else if (stat.type !== "number") {
        detail += `, ~${stat.cardinality} unique`;
      }
      lines.push(`- \`${col}\` — ${detail}`);
    } else {
      lines.push(`- \`${col}\``);
    }
  }

  if (params.columns.length > 200) {
    lines.push(``, `_(${params.columns.length - 200} more columns not shown)_`);
  }

  if (params.sampleRows.length > 0) {
    lines.push(``, `## Sample Rows`, "```json", JSON.stringify(params.sampleRows, null, 2), "```");
  }

  return lines.join("\n");
}

function renderDatasetRowsMarkdown(params: {
  datasetName: string;
  idColumn?: string;
  textColumns?: string[];
  columns: string[];
  rows: Array<Record<string, any>>;
  rowOffset: number;
}): string {
  const chosenColumns = Array.isArray(params.textColumns) && params.textColumns.length > 0
    ? params.textColumns
    : params.columns;

  const maxCols = 80;
  const columns = chosenColumns.slice(0, maxCols);

  const sections: string[] = [`# Dataset Rows: ${params.datasetName}`, ``];
  for (let i = 0; i < params.rows.length; i++) {
    const row = params.rows[i] || {};
    const rowIndex = params.rowOffset + i;
    const rowId =
      params.idColumn && row[params.idColumn] !== undefined && row[params.idColumn] !== null
        ? String(row[params.idColumn])
        : String(rowIndex + 1);

    sections.push(`## Row ${rowId}`);
    sections.push("");
    for (const col of columns) {
      const raw = row[col];
      if (raw === undefined || raw === null || raw === "") continue;
      const value = normalizeCellValue(raw);
      if (!value) continue;
      sections.push(`- **${escapeMarkdown(col)}**: ${value}`);
    }
    sections.push("");
  }

  return sections.join("\n");
}

function normalizeCellValue(value: any): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return "";
    return trimmed.length > 500 ? `${trimmed.slice(0, 500)}...` : trimmed;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    const rendered = JSON.stringify(value);
    return rendered.length > 700 ? `${rendered.slice(0, 700)}...` : rendered;
  } catch {
    return String(value);
  }
}

function escapeMarkdown(text: string): string {
  return String(text).replace(/([*_`\\])/g, "\\$1");
}
