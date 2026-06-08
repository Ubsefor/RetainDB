import type { QueryParams } from "../index.js";
import { RetainDBError } from "../errors.js";
import { RetainDBClient, type RetainDBClientConfig } from "../context.js";

type AnyRecord = Record<string, unknown>;

type IdentityOverride = {
  userId?: string;
  sessionId?: string;
};

export interface WithRetainDBOptions
  extends Partial<Omit<RetainDBClientConfig, "apiKey">> {
  apiKey?: string;
  client?: RetainDBClient;
  project?: string;
  topK?: number;
  contextPrefix?: string;
  bestEffort?: boolean;
  warn?: (message: string) => void;
  /** Auto-store user messages after each turn so future turns have context. Default: true */
  remember?: boolean;
  /**
   * Static userId to use for all calls through this model instance.
   * Use this when wrapping the model per-request so you can pass the userId at
   * model-creation time rather than relying on the runtime call input.
   *
   * @example
   * ```ts
   * // In a Next.js API route — create a scoped model per request:
   * const model = withRetainDB(openai("gpt-4o-mini"), { userId });
   * const result = streamText({ model, messages });
   * ```
   */
  userId?: string;
  /** Static sessionId to scope memories within a conversation thread. */
  sessionId?: string;
}

function warnDefault(message: string): void {
  if (typeof console !== "undefined" && typeof console.warn === "function") {
    console.warn(message);
  }
}

function trimText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function extractTextFromMessages(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const item = messages[i];
    if (!item || typeof item !== "object") continue;
    const role = trimText((item as AnyRecord).role).toLowerCase();
    if (role !== "user") continue;
    const content = (item as AnyRecord).content;
    if (typeof content === "string" && content.trim()) return content.trim();
    if (Array.isArray(content)) {
      const text = content
        .map((part) => {
          if (typeof part === "string") return part;
          if (!part || typeof part !== "object") return "";
          const record = part as AnyRecord;
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

function extractPrompt(input: unknown): string {
  if (typeof input === "string" && input.trim()) return input.trim();
  if (!input || typeof input !== "object") return "";
  const record = input as AnyRecord;
  const fromPrompt = trimText(record.prompt);
  if (fromPrompt) return fromPrompt;
  const fromInput = trimText(record.input);
  if (fromInput) return fromInput;
  return extractTextFromMessages(record.messages);
}

function extractIdentity(input: unknown): IdentityOverride {
  if (!input || typeof input !== "object") return {};
  const record = input as AnyRecord;
  const userId = trimText(record.userId || record.user_id);
  const sessionId = trimText(record.sessionId || record.session_id);
  return {
    userId: userId || undefined,
    sessionId: sessionId || undefined,
  };
}

function injectContext(input: unknown, context: string, contextPrefix: string): unknown {
  const memoryText = `${contextPrefix}\n${context}`.trim();
  if (!memoryText) return input;

  if (typeof input === "string") {
    return `${memoryText}\n\n${input}`;
  }

  if (!input || typeof input !== "object") return input;
  const record = input as AnyRecord;

  if (typeof record.prompt === "string") {
    return {
      ...record,
      prompt: `${memoryText}\n\n${record.prompt}`,
    };
  }

  if (typeof record.input === "string") {
    return {
      ...record,
      input: `${memoryText}\n\n${record.input}`,
    };
  }

  if (Array.isArray(record.messages)) {
    return {
      ...record,
      messages: [
        { role: "system", content: memoryText },
        ...record.messages,
      ],
    };
  }

  return {
    ...record,
    prompt: memoryText,
  };
}

function buildClient(config: WithRetainDBOptions): RetainDBClient {
  if (config.client) return config.client;

  const env = (typeof process !== "undefined" ? process.env : {}) as Record<
    string,
    string | undefined
  >;
  const apiKey =
    config.apiKey ||
    env.RETAINDB_API_KEY ||
    env.RetainDB_API_KEY ||
    env.USERetainDB_API_KEY ||
    env.API_KEY;
  if (!apiKey) {
    throw new RetainDBError({
      code: "INVALID_API_KEY",
      message:
        "Missing API key. Pass apiKey to withRetainDB(...) or set RETAINDB_API_KEY.",
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

async function getContextForInput(
  client: RetainDBClient,
  input: unknown,
  config: WithRetainDBOptions,
): Promise<string> {
  const query = extractPrompt(input);
  if (!query) return "";
  const identity = extractIdentity(input);
  const params: QueryParams = {
    query,
    project: config.project,
    top_k: config.topK,
    user_id: identity.userId || config.userId,
    session_id: identity.sessionId || config.sessionId,
  };
  const response = await client.query(params);
  return response.context || "";
}

function extractMessages(input: unknown): AnyRecord[] {
  if (!input || typeof input !== "object") return [];
  const record = input as AnyRecord;
  return Array.isArray(record.messages) ? (record.messages as AnyRecord[]) : [];
}

async function rememberTurn(
  input: unknown,
  config: WithRetainDBOptions,
  client: RetainDBClient,
): Promise<void> {
  const identity = extractIdentity(input);
  const userId = identity.userId || config.userId;
  if (!userId) return; // no userId means we can't scope the memory

  const messages = extractMessages(input);
  const userMessages = messages.filter((m) => {
    const role = trimText(m.role).toLowerCase();
    const content = typeof m.content === "string" ? m.content.trim() : "";
    return role === "user" && content;
  });

  if (!userMessages.length) return;

  await client.remember({
    userId,
    sessionId: identity.sessionId || config.sessionId,
    project: config.project,
    messages: userMessages.map((m) => ({
      role: "user" as const,
      content: typeof m.content === "string" ? m.content : "",
    })),
  });
}

function asRetainDBError(error: unknown): RetainDBError {
  if (error instanceof RetainDBError) return error;
  if (error instanceof Error) {
    return new RetainDBError({
      code: "REQUEST_FAILED",
      message: error.message,
      retryable: false,
      cause: error,
    });
  }
  return new RetainDBError({
    code: "REQUEST_FAILED",
    message: "Unknown adapter error",
    retryable: false,
    details: error,
  });
}

async function augmentInput(
  originalInput: unknown,
  config: WithRetainDBOptions,
  client: RetainDBClient,
): Promise<unknown> {
  try {
    const context = await getContextForInput(client, originalInput, config);
    if (!context) return originalInput;
    return injectContext(
      originalInput,
      context,
      config.contextPrefix || "Relevant context:",
    );
  } catch (error) {
    const mapped = asRetainDBError(error);
    if (config.bestEffort !== false) {
      (config.warn || warnDefault)(
        `[RetainDB SDK] withRetainDB fallback to raw model call: ${mapped.message}`,
      );
      return originalInput;
    }
    throw mapped;
  }
}

function wrapMethod(
  model: AnyRecord,
  methodName: string,
  config: WithRetainDBOptions,
  getClient: () => RetainDBClient,
): void {
  const original = model[methodName];
  if (typeof original !== "function") return;
  model[methodName] = async function wrapped(this: unknown, input: unknown, ...rest: unknown[]) {
    const augmented = await augmentInput(input, config, getClient());

    // Fire-and-forget: store the user's messages so future turns can recall them.
    // Only runs when userId is present in the input (e.g. passed via streamText's body).
    if (config.remember !== false) {
      rememberTurn(input, config, getClient()).catch((err) => {
        (config.warn || warnDefault)(
          `[RetainDB SDK] background remember failed: ${(err as Error)?.message ?? err}`,
        );
      });
    }

    return await (original as Function).call(this, augmented, ...rest);
  };
}

/**
 * Framework adapter that adds bidirectional memory to any Vercel AI SDK model.
 *
 * - **Retrieval**: before each call, relevant memories are fetched and injected
 *   into the prompt/system message automatically.
 * - **Storage**: after each call, the user's messages are stored in the background
 *   so future turns can recall them (opt out with `remember: false`).
 *
 * Requires `userId` (or `user_id`) to be present somewhere in the call input
 * (e.g. as a top-level property on the `streamText` params object) so memories
 * are scoped to the right user.
 *
 * @example
 * ```ts
 * import { withRetainDB } from "@retaindb/sdk/ai-sdk";
 * import { openai } from "@ai-sdk/openai";
 * import { streamText } from "ai";
 *
 * const result = streamText({
 *   model: withRetainDB(openai("gpt-4o-mini")),
 *   messages,
 *   userId: session.userId,   // ← scopes memory to this user
 * });
 * ```
 */
export function withRetainDB<T extends Record<string, unknown> | ((...args: any[]) => any)>(
  model: T,
  options: WithRetainDBOptions = {},
): T {
  let client: RetainDBClient | null = options.client || null;
  const getClient = () => {
    if (!client) client = buildClient(options);
    return client;
  };

  if (typeof model === "function") {
    const original = model;
    const wrapped = async (...args: unknown[]) => {
      const first = args.length > 0 ? args[0] : undefined;
      const augmented = await augmentInput(first, options, getClient());
      const finalArgs = [augmented, ...args.slice(1)];
      return await (original as Function)(...finalArgs);
    };
    return wrapped as unknown as T;
  }

  const wrappedModel = Object.create(Object.getPrototypeOf(model)) as AnyRecord;
  Object.assign(wrappedModel, model);

  wrapMethod(wrappedModel, "generate", options, getClient);
  wrapMethod(wrappedModel, "stream", options, getClient);
  wrapMethod(wrappedModel, "doGenerate", options, getClient);
  wrapMethod(wrappedModel, "doStream", options, getClient);

  return wrappedModel as T;
}
