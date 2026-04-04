import { DiagnosticsStore } from "./telemetry.js";
import type {
  CompatMode,
  DiagnosticsRecord,
  OperationType,
  RetryPolicy,
  RuntimeClientOptions,
  RuntimeRequestOptions,
  RuntimeResponse,
  TimeoutBudgets,
  UnknownPayload,
} from "./types.js";
import { normalizeBaseUrl, normalizeEndpoint, nowIso, randomId, stableHash } from "./utils.js";

const DEFAULT_TIMEOUTS: TimeoutBudgets = {
  searchMs: 3000,
  writeAckMs: 2000,
  bulkMs: 10000,
  profileMs: 2500,
  sessionMs: 2500,
};

const DEFAULT_RETRYABLE_STATUS = [408, 429, 500, 502, 503, 504];
const DEFAULT_API_KEY_ONLY_PREFIXES = ["/v1/memory", "/v1/context/query"];

const DEFAULT_RETRY_ATTEMPTS: Record<OperationType, number> = {
  search: 3,
  writeAck: 2,
  bulk: 2,
  profile: 2,
  session: 2,
  query: 3,
  get: 2,
  createSource: 1,
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toMessage(payload: unknown, status: number, statusText: string): string {
  if (typeof payload === "string" && payload.trim()) return payload;
  if (isObject(payload)) {
    const maybeError = payload.error;
    const maybeMessage = payload.message;
    if (typeof maybeError === "string" && maybeError.trim()) return maybeError;
    if (typeof maybeMessage === "string" && maybeMessage.trim()) return maybeMessage;
    if (isObject(maybeError) && typeof maybeError.message === "string") return maybeError.message;
  }
  return `HTTP ${status}: ${statusText}`;
}

export class RuntimeClientError extends Error {
  status?: number;
  retryable: boolean;
  code: string;
  details?: UnknownPayload;
  traceId?: string;
  hint?: string;
  requestId?: string;

  constructor(args: {
    message: string;
    status?: number;
    retryable: boolean;
    code: string;
    details?: UnknownPayload;
    traceId?: string;
    hint?: string;
    requestId?: string;
  }) {
    super(args.message);
    this.name = "RuntimeClientError";
    this.status = args.status;
    this.retryable = args.retryable;
    this.code = args.code;
    this.details = args.details;
    this.traceId = args.traceId;
    this.hint = args.hint;
    this.requestId = args.requestId;
  }
}

export class RuntimeClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly sdkVersion: string;
  private readonly compatMode: CompatMode;
  private readonly retryPolicy: RetryPolicy;
  private readonly timeouts: TimeoutBudgets;
  private readonly diagnostics: DiagnosticsStore;
  private readonly inFlight = new Map<string, Promise<RuntimeResponse<unknown>>>();
  private readonly sendApiKeyHeader: boolean;
  private readonly fetchImpl: typeof fetch;

  constructor(options: RuntimeClientOptions, diagnostics?: DiagnosticsStore) {
    if (!options.apiKey) {
      throw new RuntimeClientError({
        code: "INVALID_API_KEY",
        message: "API key is required",
        retryable: false,
      });
    }
    this.apiKey = options.apiKey;
    this.baseUrl = normalizeBaseUrl(options.baseUrl || "https://api.retaindb.com");
    this.sdkVersion = options.sdkVersion || "2.x-runtime";
    this.compatMode = options.compatMode || "fallback";
    this.retryPolicy = {
      retryableStatusCodes: options.retryPolicy?.retryableStatusCodes || DEFAULT_RETRYABLE_STATUS,
      retryOnNetworkError: options.retryPolicy?.retryOnNetworkError ?? true,
      maxBackoffMs: options.retryPolicy?.maxBackoffMs ?? 1200,
      baseBackoffMs: options.retryPolicy?.baseBackoffMs ?? 250,
      maxAttemptsByOperation: options.retryPolicy?.maxAttemptsByOperation || {},
    };
    this.timeouts = {
      ...DEFAULT_TIMEOUTS,
      ...(options.timeouts || {}),
    };
    this.sendApiKeyHeader = (process.env.RETAINDB_SEND_X_API_KEY ?? process.env.WHISPER_SEND_X_API_KEY) === "1";
    this.fetchImpl = options.fetchImpl || fetch;
    this.diagnostics = diagnostics || new DiagnosticsStore(1000);
  }

  getDiagnosticsStore(): DiagnosticsStore {
    return this.diagnostics;
  }

  getCompatMode(): CompatMode {
    return this.compatMode;
  }

  private timeoutFor(operation: OperationType): number {
    switch (operation) {
      case "search":
        return this.timeouts.searchMs;
      case "writeAck":
        return this.timeouts.writeAckMs;
      case "bulk":
        return this.timeouts.bulkMs;
      case "profile":
        return this.timeouts.profileMs;
      case "session":
        return this.timeouts.sessionMs;
      case "query":
      case "get":
      default:
        return this.timeouts.searchMs;
    }
  }

  private maxAttemptsFor(operation: OperationType): number {
    const override = this.retryPolicy.maxAttemptsByOperation?.[operation];
    return Math.max(1, override ?? DEFAULT_RETRY_ATTEMPTS[operation]);
  }

  private shouldRetryStatus(status?: number): boolean {
    return status !== undefined && this.retryPolicy.retryableStatusCodes?.includes(status) === true;
  }

  private backoff(attempt: number): number {
    const base = this.retryPolicy.baseBackoffMs ?? 250;
    const max = this.retryPolicy.maxBackoffMs ?? 1200;
    const jitter = 0.8 + Math.random() * 0.4;
    return Math.min(max, Math.floor(base * Math.pow(2, attempt) * jitter));
  }

  private runtimeName(): "node" | "browser" {
    const maybeWindow = (globalThis as Record<string, unknown>).window;
    return maybeWindow && typeof maybeWindow === "object" ? "browser" : "node";
  }

  private apiKeyOnlyPrefixes(): string[] {
    const raw = process.env.RETAINDB_API_KEY_ONLY_PREFIXES ?? process.env.WHISPER_API_KEY_ONLY_PREFIXES;
    if (!raw || !raw.trim()) return DEFAULT_API_KEY_ONLY_PREFIXES;
    return raw
      .split(",")
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
  }

  private shouldAttachApiKeyHeader(endpoint: string): boolean {
    if (this.sendApiKeyHeader) return true;
    const prefixes = this.apiKeyOnlyPrefixes();
    return prefixes.some((prefix) => endpoint === prefix || endpoint.startsWith(`${prefix}/`));
  }

  private createRequestFingerprint(options: RuntimeRequestOptions): string {
    const normalizedEndpoint = normalizeEndpoint(options.endpoint);
    const authFingerprint = stableHash(this.apiKey.replace(/^Bearer\s+/i, ""));
    const payload = JSON.stringify({
      method: options.method || "GET",
      endpoint: normalizedEndpoint,
      body: options.body || null,
      extra: options.dedupeKeyExtra || "",
      authFingerprint,
    });
    return stableHash(payload);
  }

  async request<T>(options: RuntimeRequestOptions): Promise<RuntimeResponse<T>> {
    const dedupeKey = options.idempotent ? this.createRequestFingerprint(options) : null;
    if (dedupeKey) {
      const inFlight = this.inFlight.get(dedupeKey);
      if (inFlight) {
        const data = await inFlight;
        this.diagnostics.add({
          id: randomId("diag"),
          startedAt: nowIso(),
          endedAt: nowIso(),
          traceId: data.traceId,
          spanId: randomId("span"),
          operation: options.operation,
          method: options.method || "GET",
          endpoint: normalizeEndpoint(options.endpoint),
          status: data.status,
          durationMs: 0,
          success: true,
          deduped: true,
        });
        const cloned: RuntimeResponse<T> = {
          data: data.data as T,
          status: data.status,
          traceId: data.traceId,
        };
        return cloned;
      }
    }

    const runner = this.performRequest<T>(options).then((data) => {
      if (dedupeKey) this.inFlight.delete(dedupeKey);
      return data;
    }).catch((error) => {
      if (dedupeKey) this.inFlight.delete(dedupeKey);
      throw error;
    });

    if (dedupeKey) {
      this.inFlight.set(dedupeKey, runner as Promise<RuntimeResponse<unknown>>);
    }

    return runner;
  }

  private async performRequest<T>(options: RuntimeRequestOptions): Promise<RuntimeResponse<T>> {
    const method = options.method || "GET";
    const normalizedEndpoint = normalizeEndpoint(options.endpoint);
    const operation = options.operation;
    const maxAttempts = this.maxAttemptsFor(operation);
    const timeoutMs = this.timeoutFor(operation);
    const traceId = options.traceId || randomId("trace");

    let lastError: RuntimeClientError | null = null;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const spanId = randomId("span");
      const startedAt = Date.now();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const attachApiKeyHeader = this.shouldAttachApiKeyHeader(normalizedEndpoint);
        const response = await this.fetchImpl(`${this.baseUrl}${normalizedEndpoint}`, {
          method,
          signal: controller.signal,
          keepalive: method !== "GET",
          headers: {
            "Content-Type": "application/json",
            Authorization: this.apiKey.startsWith("Bearer ") ? this.apiKey : `Bearer ${this.apiKey}`,
            ...(attachApiKeyHeader ? { "X-API-Key": this.apiKey.replace(/^Bearer\s+/i, "") } : {}),
            "x-trace-id": traceId,
            "x-span-id": spanId,
            "x-sdk-version": this.sdkVersion,
            "x-sdk-runtime": this.runtimeName(),
            ...(options.headers || {}),
          },
          body: method === "GET" || method === "DELETE"
            ? undefined
            : JSON.stringify(options.body || {}),
        });
        clearTimeout(timeout);

        let payload: UnknownPayload = null;
        try {
          payload = await response.json();
        } catch {
          payload = await response.text().catch(() => "");
        }

        const durationMs = Date.now() - startedAt;
        const record: DiagnosticsRecord = {
          id: randomId("diag"),
          startedAt: new Date(startedAt).toISOString(),
          endedAt: nowIso(),
          traceId,
          spanId,
          operation,
          method,
          endpoint: normalizedEndpoint,
          status: response.status,
          durationMs,
          success: response.ok,
        };
        this.diagnostics.add(record);

        if (response.ok) {
          return {
            data: payload as T,
            status: response.status,
            traceId,
          };
        }

        const message = toMessage(payload, response.status, response.statusText);
        const payloadObject = isObject(payload) ? payload : {};
        const payloadCode = typeof payloadObject.code === "string" ? payloadObject.code : undefined;
        const payloadHint = typeof payloadObject.hint === "string" ? payloadObject.hint : undefined;
        const payloadRequestId =
          typeof payloadObject.requestId === "string"
            ? payloadObject.requestId
            : typeof payloadObject.request_id === "string"
              ? payloadObject.request_id
              : undefined;
        const payloadRetryable = typeof payloadObject.retryable === "boolean" ? payloadObject.retryable : undefined;
        const statusRetryable = this.shouldRetryStatus(response.status);
        const retryable = payloadRetryable ?? statusRetryable;
        const error = new RuntimeClientError({
          message,
          status: response.status,
          retryable,
          code: payloadCode || (response.status === 404 ? "NOT_FOUND" : "REQUEST_FAILED"),
          details: payload,
          traceId: payloadRequestId || traceId,
          requestId: payloadRequestId || traceId,
          hint: payloadHint,
        });
        lastError = error;
        if (!retryable || attempt === maxAttempts - 1) {
          throw error;
        }
      } catch (error: unknown) {
        clearTimeout(timeout);
        const durationMs = Date.now() - startedAt;
        const isAbort = isObject(error) && error.name === "AbortError";
        const mapped = error instanceof RuntimeClientError
          ? error
          : new RuntimeClientError({
              message: isAbort ? "Request timed out" : (error instanceof Error ? error.message : "Network error"),
              retryable: this.retryPolicy.retryOnNetworkError ?? true,
              code: isAbort ? "TIMEOUT" : "NETWORK_ERROR",
              traceId,
              requestId: traceId,
            });
        lastError = mapped;

        this.diagnostics.add({
          id: randomId("diag"),
          startedAt: new Date(startedAt).toISOString(),
          endedAt: nowIso(),
          traceId,
          spanId,
          operation,
          method,
          endpoint: normalizedEndpoint,
          durationMs,
          success: false,
          errorCode: mapped.code,
          errorMessage: mapped.message,
        });

        if (!mapped.retryable || attempt === maxAttempts - 1) {
          throw mapped;
        }
      }

      await new Promise((resolve) => setTimeout(resolve, this.backoff(attempt)));
    }

    throw lastError || new RuntimeClientError({
      message: "Request failed",
      retryable: false,
      code: "REQUEST_FAILED",
    });
  }
}
