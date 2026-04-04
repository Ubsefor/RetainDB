export type McpSearchMode = "exact" | "semantic" | "hybrid";

export type McpSearchResult = {
  id: string | null;
  content: string;
  score: number | null;
  source: string | null;
  document: string | null;
  metadata: Record<string, any> | null;
};

export type McpExactMemory = {
  id: string | null;
  type: string | null;
  content: string;
  user_id: string | null;
  session_id: string | null;
  updated_at: string | null;
  metadata: Record<string, any> | null;
};

export type McpSearchPayload = {
  success: true;
  mode: McpSearchMode;
  query: string | null;
  id: string | null;
  exact_memory: McpExactMemory | null;
  context: string;
  results: McpSearchResult[];
  count: number;
  degraded_mode: boolean;
  degraded_reason: string | null;
  warnings: string[];
};

export type McpSearchError = {
  success: false;
  error: {
    code: string;
    message: string;
  };
};

export type PrimaryToolSuccess<T extends Record<string, any> = Record<string, any>> = { success: true } & T;
export type PrimaryToolError = McpSearchError;

export function normalizeExactMemory(memory?: Record<string, any> | null): McpExactMemory | null;
export function normalizeSearchResults(results?: Array<Record<string, any>> | null): McpSearchResult[];
export function normalizeCanonicalResults(input?: { results?: Array<Record<string, any>> | null; memories?: Array<Record<string, any>> | null } | null): Array<Record<string, any>>;
export function buildPrimaryToolSuccess<T extends Record<string, any>>(payload: T): PrimaryToolSuccess<T>;
export function buildPrimaryToolError(message: string, options?: { code?: string }): PrimaryToolError;
export function buildMcpSearchPayload(input: {
  mode: McpSearchMode;
  query?: string | null;
  id?: string | null;
  exactMemory?: Record<string, any> | null;
  context?: string | null;
  results?: Array<Record<string, any>> | null;
  degradedMode?: boolean;
  degradedReason?: string | null;
  warnings?: string[];
}): McpSearchPayload;
export function buildMcpSearchError(
  message: string,
  options?: { status?: number; code?: string }
): McpSearchError;
