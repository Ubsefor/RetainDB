const TERM_EXPANSIONS: Array<[RegExp, string]> = [
  [/\bgf\b/gi, "girlfriend"],
  [/\bbf\b/gi, "boyfriend"],
];

const FIRST_PERSON_CANONICAL: Array<[RegExp, string]> = [
  [/\bi'm\b/gi, "the user is"],
  [/\bi am\b/gi, "the user is"],
  [/\bi\b/gi, "the user"],
  [/\bme\b/gi, "the user"],
  [/\bmy\b/gi, "the user's"],
  [/\bmine\b/gi, "the user's"],
];

const THIRD_PERSON_USER_CANONICAL: Array<[RegExp, string]> = [
  [/\bhis\b/gi, "the user's"],
  [/\bher\b/gi, "the user's"],
  [/\btheir\b/gi, "the user's"],
  [/\bhe\b/gi, "the user"],
  [/\bshe\b/gi, "the user"],
  [/\bthey\b/gi, "the user"],
];

function normalizeWhitespace(value: string): string {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function applyRules(value: string, rules: Array<[RegExp, string]>): string {
  return rules.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), value);
}

function normalizeCase(value: string): string {
  return normalizeWhitespace(value).toLowerCase();
}

export interface MemoryNormalizationFields {
  normalized_content: string;
  canonical_content: string;
  search_text: string;
  search_variants: string[];
  semantic_status: "pending" | "ready";
}

export function buildMemoryNormalizationFields(content: string): MemoryNormalizationFields {
  const normalized = normalizeWhitespace(content);
  const expanded = applyRules(normalized, TERM_EXPANSIONS);
  const canonical = applyRules(expanded, FIRST_PERSON_CANONICAL);
  const thirdPersonCanonical = applyRules(expanded, THIRD_PERSON_USER_CANONICAL);
  const firstPersonVariant = canonical
    .replace(/\bthe user's\b/gi, "my")
    .replace(/\bthe user is\b/gi, "i am")
    .replace(/\bthe user\b/gi, "i");

  const variants = Array.from(
    new Set(
      [normalized, expanded, canonical, thirdPersonCanonical, firstPersonVariant]
        .map((item) => normalizeCase(item))
        .filter(Boolean)
    )
  );

  return {
    normalized_content: normalizeCase(normalized),
    canonical_content: normalizeCase(canonical),
    search_text: variants.join(" | "),
    search_variants: variants,
    semantic_status: "pending",
  };
}

export function mergeMemoryNormalizationMetadata(
  metadata: Record<string, unknown> | null | undefined,
  content: string
): Record<string, unknown> {
  return {
    ...(metadata || {}),
    ...buildMemoryNormalizationFields(content),
  };
}

export function expandMemorySearchQueries(query: string): string[] {
  const normalized = normalizeWhitespace(query);
  if (!normalized) return [];
  return buildMemoryNormalizationFields(normalized).search_variants;
}

export function getMemorySemanticStatus(metadata: unknown): "pending" | "ready" {
  if (metadata && typeof metadata === "object") {
    const value = String((metadata as Record<string, unknown>).semantic_status || "").toLowerCase();
    if (value === "ready") return "ready";
  }
  return "pending";
}
