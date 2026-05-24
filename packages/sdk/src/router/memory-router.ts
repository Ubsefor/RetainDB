import { RetainDBError } from "../errors.js";
import { RetainDBClient, type RetainDBClientConfig } from "../whisper.js";

type ChatMessage = {
  role: string;
  content: unknown;
};

type ChatCompletionPayload = {
  model?: string;
  messages?: ChatMessage[];
  user?: string;
  [key: string]: unknown;
};

export type MemoryRouterFallbackReason =
  | "none"
  | "no_user_prompt"
  | "memory_query_failed";

export interface MemoryRouterTrace {
  providerUrl: string;
  requestId: string;
  usedMemory: boolean;
  fallbackReason: MemoryRouterFallbackReason;
  providerStatus?: number;
  model?: string;
}

export interface MemoryRouterResult<T = unknown> {
  status: number;
  data: T;
  trace: MemoryRouterTrace;
}

export interface MemoryRouterConfig
  extends Partial<Omit<RetainDBClientConfig, "apiKey">> {
  apiKey?: string;
  client?: RetainDBClient;
  project?: string;
  providerBaseUrl: string;
  providerApiKey?: string;
  providerHeaders?: Record<string, string>;
  routePath?: string;
  beta?: boolean;
  bestEffort?: boolean;
  contextPrefix?: string;
  logger?: (trace: MemoryRouterTrace) => void;
}

function randomRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `req_${Math.random().toString(36).slice(2, 11)}`;
}

function normalizeProviderUrl(baseUrl: string, routePath: string): string {
  const trimmedBase = baseUrl.replace(/\/+$/, "");
  const normalizedPath = routePath.startsWith("/") ? routePath : `/${routePath}`;
  return `${trimmedBase}${normalizedPath}`;
}

function trimText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function extractUserPrompt(messages: ChatMessage[] | undefined): string {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const item = messages[i];
    if (!item || typeof item !== "object") continue;
    if (trimText(item.role).toLowerCase() !== "user") continue;
    const content = item.content;
    if (typeof content === "string" && content.trim()) return content.trim();
    if (Array.isArray(content)) {
      const text = content
        .map((part) => {
          if (typeof part === "string") return part;
          if (!part || typeof part !== "object") return "";
          const record = part as Record<string, unknown>;
          if (trimText(record.type).toLowerCase() !== "text") return "";
          return trimText(record.text);
        })
        .filter((part) => part.length > 0)
        .join("\n");
      if (text) return text;
    }
  }
  return "";
}

function buildClient(config: MemoryRouterConfig): RetainDBClient {
  if (config.client) return config.client;

  const env = (typeof process !== "undefined" ? process.env : {}) as Record<
    string,
    string | undefined
  >;
  const apiKey =
    config.apiKey ||
    env.RETAINDB_API_KEY ||
    env.WHISPER_API_KEY ||
    env.USEWHISPER_API_KEY ||
    env.API_KEY;
  if (!apiKey) {
    throw new RetainDBError({
      code: "INVALID_API_KEY",
      message:
        "Missing API key. Pass apiKey to createMemoryRouter(...) or set RETAINDB_API_KEY.",
      retryable: false,
    });
  }

  return new RetainDBClient({
    apiKey,
    baseUrl: config.baseUrl,
    project: config.project,
    identityMode: config.identityMode,
    getIdentity: config.getIdentity,
    environment: config.environment,
    strictIdentityMode: config.strictIdentityMode,
    compatMode: config.compatMode,
    fetch: config.fetch,
    timeouts: config.timeouts,
    retryPolicy: config.retryPolicy,
    cache: config.cache,
    queue: config.queue,
    telemetry: config.telemetry,
  });
}

function ensureBetaEnabled(_explicitBeta?: boolean): void {
  // Memory Router is production-ready. No opt-in required.
}

export class RetainDBMemoryRouter {
  private readonly config: MemoryRouterConfig;
  private readonly providerUrl: string;
  private readonly fetchImpl: typeof fetch;
  private client: RetainDBClient | null = null;
  private lastTrace: MemoryRouterTrace | null = null;

  constructor(config: MemoryRouterConfig) {
    ensureBetaEnabled(config.beta);
    this.config = config;
    this.providerUrl = normalizeProviderUrl(
      config.providerBaseUrl,
      config.routePath || "/v1/chat/completions",
    );
    this.fetchImpl = config.fetch || fetch;
  }

  private getClient(): RetainDBClient {
    if (!this.client) this.client = buildClient(this.config);
    return this.client;
  }

  getLastTrace(): MemoryRouterTrace | null {
    return this.lastTrace ? { ...this.lastTrace } : null;
  }

  async chatCompletions<T = unknown>(
    payload: ChatCompletionPayload,
  ): Promise<MemoryRouterResult<T>> {
    const requestId = randomRequestId();
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    const prompt = extractUserPrompt(messages);
    const contextPrefix = this.config.contextPrefix || "Relevant memory context:";

    let usedMemory = false;
    let fallbackReason: MemoryRouterFallbackReason = "none";
    let contextText = "";

    if (!prompt) {
      fallbackReason = "no_user_prompt";
    } else {
      try {
        const queryResult = await this.getClient().query({
          query: prompt,
          project: this.config.project,
          user_id: trimText(payload.user) || undefined,
        });
        if (queryResult.context && queryResult.context.trim()) {
          contextText = queryResult.context.trim();
          usedMemory = true;
        }
      } catch (error) {
        if (this.config.bestEffort === false) {
          throw error;
        }
        fallbackReason = "memory_query_failed";
      }
    }

    const providerPayload: ChatCompletionPayload = {
      ...payload,
      messages: usedMemory
        ? [
            {
              role: "system",
              content: `${contextPrefix}\n${contextText}`,
            },
            ...messages,
          ]
        : messages,
    };

    const env = (typeof process !== "undefined" ? process.env : {}) as Record<
      string,
      string | undefined
    >;
    const providerApiKey =
      this.config.providerApiKey || env.MEMORY_ROUTER_PROVIDER_API_KEY || "";
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-retaindb-memory-router": "beta",
      "x-retaindb-request-id": requestId,
      ...(this.config.providerHeaders || {}),
    };
    if (providerApiKey) {
      headers.Authorization = providerApiKey.startsWith("Bearer ")
        ? providerApiKey
        : `Bearer ${providerApiKey}`;
    }

    const response = await this.fetchImpl(this.providerUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(providerPayload),
    });
    const parsed = await response
      .json()
      .catch(async () => await response.text().catch(() => null));

    const trace: MemoryRouterTrace = {
      providerUrl: this.providerUrl,
      requestId,
      usedMemory,
      fallbackReason,
      providerStatus: response.status,
      model: trimText(payload.model) || undefined,
    };
    this.lastTrace = trace;
    if (this.config.logger) this.config.logger(trace);

    if (!response.ok) {
      throw new RetainDBError({
        code: response.status >= 500 ? "TEMPORARY_UNAVAILABLE" : "REQUEST_FAILED",
        status: response.status,
        message:
          typeof parsed === "object" && parsed && "error" in (parsed as any)
            ? String((parsed as any).error?.message || "Provider request failed")
            : "Provider request failed",
        retryable: response.status >= 500 || response.status === 429,
        requestId,
        details: {
          providerUrl: this.providerUrl,
          body: parsed,
          trace,
        },
      });
    }

    return {
      status: response.status,
      data: parsed as T,
      trace,
    };
  }
}

export function createMemoryRouter(config: MemoryRouterConfig): RetainDBMemoryRouter {
  return new RetainDBMemoryRouter(config);
}

