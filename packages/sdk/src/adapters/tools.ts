import { z } from "zod";
import { RetainDBError } from "../errors.js";
import { RetainDBClient, type RetainDBClientConfig } from "../context.js";

export interface RetainDBToolsOptions
  extends Partial<Omit<RetainDBClientConfig, "apiKey">> {
  apiKey?: string;
  client?: RetainDBClient;
  project?: string;
  searchTopK?: number;
}

export interface RetainDBToolDefinition<TInput, TResult> {
  description: string;
  inputSchema: z.ZodType<TInput>;
  execute: (input: TInput) => Promise<TResult>;
}

type SearchInput = {
  q: string;
  project?: string;
  topK?: number;
  userId?: string;
  sessionId?: string;
};

type RememberInput = {
  content: string;
  project?: string;
  memoryType?:
    | "factual"
    | "preference"
    | "event"
    | "relationship"
    | "opinion"
    | "goal"
    | "instruction";
  userId?: string;
  sessionId?: string;
  metadata?: Record<string, unknown>;
};

const searchInputSchema: z.ZodType<SearchInput> = z.object({
  q: z.string().min(1),
  project: z.string().optional(),
  topK: z.number().int().positive().max(50).optional(),
  userId: z.string().optional(),
  sessionId: z.string().optional(),
});

const rememberInputSchema: z.ZodType<RememberInput> = z.object({
  content: z.string().min(1),
  project: z.string().optional(),
  memoryType: z
    .enum([
      "factual",
      "preference",
      "event",
      "relationship",
      "opinion",
      "goal",
      "instruction",
    ])
    .optional(),
  userId: z.string().optional(),
  sessionId: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

function buildClient(config: RetainDBToolsOptions): RetainDBClient {
  if (config.client) return config.client;

  const env = (typeof process !== "undefined" ? process.env : {}) as Record<
    string,
    string | undefined
  >;
  const apiKey =
    config.apiKey ||
    env.RETAINDB_API_KEY ||
    env.API_KEY;
  if (!apiKey) {
    throw new RetainDBError({
      code: "INVALID_API_KEY",
      message:
        "Missing API key. Pass apiKey to retaindbTools(...) or set RETAINDB_API_KEY.",
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

export function retaindbTools(config: RetainDBToolsOptions = {}) {
  let client: RetainDBClient | null = config.client || null;
  const getClient = () => {
    if (!client) client = buildClient(config);
    return client;
  };

  const retaindb_search: RetainDBToolDefinition<
    SearchInput,
    {
      context: string;
      total: number;
      results: Array<{
        id: string;
        score: number;
        source: string;
        snippet: string;
      }>;
    }
  > = {
    description:
      "Search indexed context and return grounded snippets plus packed context.",
    inputSchema: searchInputSchema,
    execute: async (input) => {
      const parsed = searchInputSchema.parse(input);
      const response = await getClient().query({
        query: parsed.q,
        project: parsed.project || config.project,
        top_k: parsed.topK || config.searchTopK,
        user_id: parsed.userId,
        session_id: parsed.sessionId,
      });
      return {
        context: response.context,
        total: response.meta.total,
        results: response.results.map((item) => ({
          id: item.id,
          score: item.score,
          source: item.source,
          snippet: item.content,
        })),
      };
    },
  };

  const retaindb_remember: RetainDBToolDefinition<
    RememberInput,
    { success: boolean }
  > = {
    description: "Store durable memory in RetainDB for future retrieval.",
    inputSchema: rememberInputSchema,
    execute: async (input) => {
      const parsed = rememberInputSchema.parse(input);
      await getClient().memory.add({
        project: parsed.project || config.project,
        content: parsed.content,
        memory_type: parsed.memoryType || "factual",
        user_id: parsed.userId,
        session_id: parsed.sessionId,
        metadata: parsed.metadata || {},
      });
      return { success: true };
    },
  };

  const retaindb_preflight: RetainDBToolDefinition<
    { project?: string; requireIdentity?: boolean },
    Awaited<ReturnType<RetainDBClient["preflight"]>>
  > = {
    description:
      "Run RetainDB readiness checks (api key, connectivity, project access, identity).",
    inputSchema: z.object({
      project: z.string().optional(),
      requireIdentity: z.boolean().optional(),
    }),
    execute: async (input) => {
      const parsed = input || {};
      return await getClient().preflight({
        project: parsed.project,
        requireIdentity: parsed.requireIdentity,
      });
    },
  };

  return {
    retaindb_search,
    retaindb_remember,
    retaindb_preflight,
  };
}
