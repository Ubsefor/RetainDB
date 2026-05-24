export type UnknownPayload = unknown;

export type CompatMode = "fallback" | "strict";

export type OperationType =
  | "search"
  | "writeAck"
  | "bulk"
  | "profile"
  | "session"
  | "query"
  | "get"
  | "createSource";

export interface TimeoutBudgets {
  searchMs: number;
  writeAckMs: number;
  bulkMs: number;
  profileMs: number;
  sessionMs: number;
}

export interface RetryPolicy {
  maxAttemptsByOperation?: Partial<Record<OperationType, number>>;
  retryableStatusCodes?: number[];
  retryOnNetworkError?: boolean;
  maxBackoffMs?: number;
  baseBackoffMs?: number;
}

export interface RuntimeRequestOptions {
  endpoint: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: Record<string, unknown> | undefined;
  headers?: Record<string, string> | undefined;
  operation: OperationType;
  idempotent?: boolean;
  traceId?: string;
  dedupeKeyExtra?: string;
}

export interface RuntimeClientOptions {
  apiKey?: string;
  baseUrl?: string;
  sdkVersion?: string;
  compatMode?: CompatMode;
  timeouts?: Partial<TimeoutBudgets>;
  retryPolicy?: RetryPolicy;
  fetchImpl?: typeof fetch;
}

export interface RuntimeResponse<T> {
  data: T;
  status: number;
  traceId: string;
}

export interface DiagnosticsRecord {
  id: string;
  startedAt: string;
  endedAt: string;
  traceId: string;
  spanId: string;
  operation: OperationType;
  method: string;
  endpoint: string;
  status?: number;
  durationMs: number;
  success: boolean;
  deduped?: boolean;
  errorCode?: string;
  errorMessage?: string;
}
