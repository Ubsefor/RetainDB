import * as fs from "fs";
import * as path from "path";

export type IngestionProfile =
  | "auto"
  | "repo"
  | "web_docs"
  | "pdf_layout"
  | "video_transcript"
  | "plain_text";

export type StrategyOverride =
  | "fixed"
  | "recursive"
  | "semantic"
  | "hierarchical"
  | "adaptive";

export interface ProfileConfig {
  tables?: {
    preserve_tables?: boolean;
  };
  semantic?: {
    semantic_refine?: boolean;
    topic_shift_sensitivity?: number;
  };
  ocr?: {
    ocr_fallback?: boolean;
  };
  hierarchy?: {
    parent_chunk_target?: number;
    child_chunk_target?: number;
    max_children_per_parent?: number;
  };
  freshness?: {
    version?: string;
    updated_at?: string;
    published_at?: string;
  };
}

export interface DocumentClassification {
  profile_candidate: Exclude<IngestionProfile, "auto">;
  confidence: number;
  document_signals: string[];
  reason: string;
}

export interface ResolvedIngestionPlan {
  profile: Exclude<IngestionProfile, "auto">;
  strategy: Exclude<StrategyOverride, "adaptive"> | "layout_aware" | "metadata_enriched";
  parser: string;
  parser_confidence: number;
  adaptive_used: boolean;
  latency_budget_ms: number;
  classification: DocumentClassification;
}

export interface IngestionPlanInput {
  content: string;
  filePath?: string;
  sourceType?: string;
  metadata?: Record<string, any>;
  ingestionProfile?: IngestionProfile;
  strategyOverride?: StrategyOverride;
  profileConfig?: ProfileConfig;
}

interface IngestionTuningConfig {
  generated_at?: string;
  evidence?: Record<string, any>;
  thresholds?: {
    classify_confidence?: number;
    parser_confidence?: number;
  };
  latency_budgets_ms?: Partial<Record<Exclude<IngestionProfile, "auto">, number>>;
  parser_confidence_adjustments?: Partial<Record<Exclude<IngestionProfile, "auto">, number>>;
}

const DEFAULT_CLASSIFY_CONFIDENCE_THRESHOLD = 0.8;
const DEFAULT_PARSER_CONFIDENCE_THRESHOLD = 0.7;
const DEFAULT_LATENCY_BUDGETS_MS: Record<Exclude<IngestionProfile, "auto">, number> = {
  repo: 90,
  web_docs: 90,
  pdf_layout: 130,
  video_transcript: 120,
  plain_text: 70,
};
const DEFAULT_TUNING_CONFIG_PATH = process.env.INGESTION_TUNING_PATH || path.resolve(process.cwd(), "config", "ingestion-tuning.json");

function loadTuningConfig(): IngestionTuningConfig {
  try {
    if (!fs.existsSync(DEFAULT_TUNING_CONFIG_PATH)) return {};
    return JSON.parse(fs.readFileSync(DEFAULT_TUNING_CONFIG_PATH, "utf8")) as IngestionTuningConfig;
  } catch (error) {
    console.warn("[IngestionProfiles] Failed to load tuning config:", (error as any)?.message || error);
    return {};
  }
}

const TUNING_CONFIG = loadTuningConfig();
const CLASSIFY_CONFIDENCE_THRESHOLD = clamp(
  TUNING_CONFIG.thresholds?.classify_confidence ?? DEFAULT_CLASSIFY_CONFIDENCE_THRESHOLD
);
const PARSER_CONFIDENCE_THRESHOLD = clamp(
  TUNING_CONFIG.thresholds?.parser_confidence ?? DEFAULT_PARSER_CONFIDENCE_THRESHOLD
);

function clamp(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, value));
}

function extOf(filePath?: string): string {
  if (!filePath || !filePath.includes(".")) return "";
  return `.${filePath.split(".").pop()!.toLowerCase()}`;
}

function hasMarkdownHeadings(content: string): boolean {
  return /^(#{1,6})\s+\S+/m.test(content);
}

function looksLikeTranscript(content: string, metadata?: Record<string, any>): boolean {
  return Boolean(
    metadata?.source_kind === "video" ||
    metadata?.timestamp_start_ms !== undefined ||
    /\b\d{1,2}:\d{2}(?::\d{2})?\b/.test(content)
  );
}

function looksLikePdf(filePath?: string, metadata?: Record<string, any>, sourceType?: string): boolean {
  return Boolean(
    sourceType === "pdf" ||
    metadata?.source === "pdf" ||
    metadata?.source_type === "pdf" ||
    extOf(filePath) === ".pdf"
  );
}

function looksLikeRepo(filePath?: string, metadata?: Record<string, any>, sourceType?: string): boolean {
  const ext = extOf(filePath);
  return Boolean(
    sourceType === "repo" ||
    sourceType === "github" ||
    sourceType === "gitlab" ||
    metadata?.repo ||
    metadata?.branch ||
    [
      ".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".java", ".rb", ".php", ".cs",
      ".swift", ".kt", ".scala", ".c", ".cpp", ".h", ".hpp", ".sql", ".prisma", ".graphql",
      ".md", ".mdx", ".rst", ".json", ".yaml", ".yml", ".toml",
    ].includes(ext)
  );
}

function looksLikeWeb(metadata?: Record<string, any>, sourceType?: string): boolean {
  return Boolean(
    sourceType === "web" ||
    sourceType === "url" ||
    metadata?.source === "web" ||
    metadata?.url ||
    metadata?.canonical_url ||
    metadata?.siteName
  );
}

export function normalizeProfileConfig(config?: ProfileConfig): ProfileConfig {
  return {
    tables: {
      preserve_tables: config?.tables?.preserve_tables ?? true,
    },
    semantic: {
      semantic_refine: config?.semantic?.semantic_refine ?? false,
      topic_shift_sensitivity: clamp(config?.semantic?.topic_shift_sensitivity ?? 0.55, 0, 1),
    },
    ocr: {
      ocr_fallback: config?.ocr?.ocr_fallback ?? false,
    },
    hierarchy: {
      parent_chunk_target: Math.max(700, Math.floor(config?.hierarchy?.parent_chunk_target ?? 1800)),
      child_chunk_target: Math.max(250, Math.floor(config?.hierarchy?.child_chunk_target ?? 700)),
      max_children_per_parent: Math.max(2, Math.floor(config?.hierarchy?.max_children_per_parent ?? 4)),
    },
    freshness: {
      version: config?.freshness?.version,
      updated_at: config?.freshness?.updated_at,
      published_at: config?.freshness?.published_at,
    },
  };
}

export function classifyDocument(input: IngestionPlanInput): DocumentClassification {
  const { content, filePath, sourceType, metadata = {} } = input;
  const signals: string[] = [];

  if (looksLikeTranscript(content, metadata)) {
    signals.push("video_timestamps", "transcript_segments");
    return {
      profile_candidate: "video_transcript",
      confidence: 0.98,
      document_signals: signals,
      reason: "Video timestamps or transcript-like segments detected.",
    };
  }

  if (looksLikePdf(filePath, metadata, sourceType)) {
    signals.push("pdf_source");
    if (/\f/.test(content) || /--- Page \d+ ---/i.test(content)) signals.push("page_markers");
    if (/\|.+\|/.test(content)) signals.push("table_like_content");
    return {
      profile_candidate: "pdf_layout",
      confidence: signals.includes("page_markers") ? 0.96 : 0.9,
      document_signals: signals,
      reason: "PDF source markers or PDF file path detected.",
    };
  }

  if (looksLikeWeb(metadata, sourceType)) {
    signals.push("web_source");
    if (hasMarkdownHeadings(content)) signals.push("heading_structure");
    if (/```/.test(content)) signals.push("code_blocks");
    return {
      profile_candidate: "web_docs",
      confidence: hasMarkdownHeadings(content) ? 0.91 : 0.86,
      document_signals: signals,
      reason: "Web/documentation source metadata detected.",
    };
  }

  if (looksLikeRepo(filePath, metadata, sourceType)) {
    signals.push("repo_source");
    const ext = extOf(filePath);
    if ([".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".java"].includes(ext)) {
      signals.push("code_file");
    }
    if (hasMarkdownHeadings(content)) signals.push("docs_heading_structure");
    return {
      profile_candidate: "repo",
      confidence: signals.includes("code_file") ? 0.93 : 0.84,
      document_signals: signals,
      reason: "Repository-like file path or repo metadata detected.",
    };
  }

  if (content.length > 5000) signals.push("long_form");
  if (hasMarkdownHeadings(content)) signals.push("heading_structure");
  if (!signals.includes("heading_structure")) signals.push("weak_structure");
  return {
    profile_candidate: "plain_text",
    confidence: signals.includes("heading_structure") ? 0.74 : 0.62,
    document_signals: signals,
    reason: "No stronger repo/web/pdf/video signals detected.",
  };
}

function defaultStrategyForProfile(profile: Exclude<IngestionProfile, "auto">): ResolvedIngestionPlan["strategy"] {
  switch (profile) {
    case "repo":
      return "hierarchical";
    case "web_docs":
      return "hierarchical";
    case "pdf_layout":
      return "layout_aware";
    case "video_transcript":
      return "hierarchical";
    case "plain_text":
    default:
      return "recursive";
  }
}

function parserForProfile(profile: Exclude<IngestionProfile, "auto">): string {
  switch (profile) {
    case "repo":
      return "repo_structure";
    case "web_docs":
      return "dom_heading";
    case "pdf_layout":
      return "page_layout";
    case "video_transcript":
      return "transcript_topic";
    case "plain_text":
    default:
      return "plain_recursive";
  }
}

function latencyBudgetForProfile(profile: Exclude<IngestionProfile, "auto">): number {
  return Math.max(
    40,
    Math.floor(
      TUNING_CONFIG.latency_budgets_ms?.[profile] ??
        DEFAULT_LATENCY_BUDGETS_MS[profile] ??
        DEFAULT_LATENCY_BUDGETS_MS.repo
    )
  );
}

function parserConfidenceForProfile(
  profile: Exclude<IngestionProfile, "auto">,
  classification: DocumentClassification,
  input: IngestionPlanInput
): number {
  const content = input.content || "";
  const signals = new Set(classification.document_signals);

  // Keep parser confidence meaningfully below 0.70 for weakly structured inputs,
  // otherwise the adaptive gate degenerates into a classify-confidence-only check.
  switch (profile) {
    case "repo":
      return clamp(
        0.6 +
          (signals.has("code_file") ? 0.18 : 0) +
          (signals.has("docs_heading_structure") ? 0.08 : 0) +
          (content.includes("{") || content.includes("function") ? 0.06 : 0) +
          (TUNING_CONFIG.parser_confidence_adjustments?.repo || 0)
      );
    case "web_docs":
      return clamp(
        0.58 +
          (signals.has("heading_structure") ? 0.14 : 0) +
          (signals.has("code_blocks") ? 0.08 : 0) +
          (/(^|\n)\|.+\|/m.test(content) ? 0.06 : 0) +
          (TUNING_CONFIG.parser_confidence_adjustments?.web_docs || 0)
      );
    case "pdf_layout":
      return clamp(
        0.56 +
          (signals.has("page_markers") ? 0.16 : 0) +
          (signals.has("table_like_content") ? 0.1 : 0) +
          (TUNING_CONFIG.parser_confidence_adjustments?.pdf_layout || 0)
      );
    case "video_transcript":
      return clamp(
        0.6 +
          (signals.has("video_timestamps") ? 0.14 : 0) +
          (signals.has("transcript_segments") ? 0.08 : 0) +
          (TUNING_CONFIG.parser_confidence_adjustments?.video_transcript || 0)
      );
    case "plain_text":
    default:
      return clamp(
        0.58 +
          (signals.has("heading_structure") ? 0.1 : 0) -
          (signals.has("weak_structure") ? 0.08 : 0) +
          (TUNING_CONFIG.parser_confidence_adjustments?.plain_text || 0)
      );
  }
}

export function buildFreshnessMetadata(
  profile: Exclude<IngestionProfile, "auto">,
  metadata: Record<string, any> = {},
  profileConfig?: ProfileConfig
): Record<string, any> {
  const normalizedConfig = normalizeProfileConfig(profileConfig);
  const freshness: Record<string, any> = {
    profile,
    ingest_timestamp: new Date().toISOString(),
  };

  if (profile === "repo") {
    freshness.commit = metadata.commit || metadata.commit_sha || metadata.sha || null;
    freshness.commit_timestamp = metadata.commit_timestamp || metadata.lastModified || null;
    freshness.branch = metadata.branch || null;
    freshness.file_path = metadata.filePath || metadata.path || null;
  } else if (profile === "web_docs") {
    freshness.published_at = normalizedConfig.freshness?.published_at || metadata.publishedAt || metadata.published_at || null;
    freshness.updated_at = normalizedConfig.freshness?.updated_at || metadata.updatedAt || metadata.updated_at || metadata.lastModified || null;
    freshness.canonical_url = metadata.canonical_url || metadata.url || null;
    freshness.last_modified = metadata.lastModified || null;
  } else if (profile === "pdf_layout") {
    freshness.document_date = metadata.document_date || metadata.documentDate || null;
    freshness.version = normalizedConfig.freshness?.version || metadata.version || metadata.revision || null;
  } else if (profile === "video_transcript") {
    freshness.published_at = normalizedConfig.freshness?.published_at || metadata.published_at || null;
    freshness.transcript_retrieved_at = metadata.transcript_retrieved_at || null;
    freshness.source_url = metadata.video_url || metadata.url || null;
  } else {
    freshness.version = normalizedConfig.freshness?.version || metadata.version || null;
    freshness.updated_at = normalizedConfig.freshness?.updated_at || metadata.updated_at || metadata.lastModified || null;
  }

  return freshness;
}

export function resolveIngestionPlan(input: IngestionPlanInput): ResolvedIngestionPlan {
  const classification =
    input.ingestionProfile && input.ingestionProfile !== "auto"
      ? {
          profile_candidate: input.ingestionProfile,
          confidence: 1,
          document_signals: ["explicit_profile"],
          reason: "Explicit ingestion profile requested.",
        }
      : classifyDocument(input);

  const profile = classification.profile_candidate;
  const parser_confidence = parserConfidenceForProfile(profile, classification, input);
  const adaptiveAllowed =
    classification.confidence < CLASSIFY_CONFIDENCE_THRESHOLD ||
    parser_confidence < PARSER_CONFIDENCE_THRESHOLD;

  let strategy: ResolvedIngestionPlan["strategy"] = defaultStrategyForProfile(profile);
  let adaptive_used = false;

  if (input.strategyOverride && input.strategyOverride !== "adaptive") {
    strategy = input.strategyOverride;
  } else if (input.strategyOverride === "adaptive") {
    adaptive_used = adaptiveAllowed;
    if (adaptiveAllowed) {
      if (profile === "pdf_layout") {
        strategy = "layout_aware";
      } else if (classification.document_signals.includes("weak_structure")) {
        strategy = "semantic";
      } else {
        strategy = defaultStrategyForProfile(profile);
      }
    } else {
      strategy = defaultStrategyForProfile(profile);
    }
  } else if (adaptiveAllowed && normalizeProfileConfig(input.profileConfig).semantic?.semantic_refine) {
    adaptive_used = true;
    strategy = profile === "plain_text" ? "semantic" : defaultStrategyForProfile(profile);
  }

  return {
    profile,
    strategy,
    parser: parserForProfile(profile),
    parser_confidence,
    adaptive_used,
    latency_budget_ms: latencyBudgetForProfile(profile),
    classification,
  };
}
