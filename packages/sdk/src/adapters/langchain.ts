import type { RetainDB } from "../retaindb.js";
import type { RetainDBClient } from "../whisper.js";

export interface LangChainMemoryAdapterOptions {
  userId: string;
  sessionId?: string;
  memoryKey?: string;
  topK?: number;
}

/**
 * LangChain BaseMemory-compatible adapter for RetainDB.
 *
 * Preferred usage — just use RetainDB directly with LCEL:
 *
 *   const { response } = await db.user(userId).runTurn({ messages, generate });
 *
 * Use this adapter only when you need to plug into an existing LangChain
 * chain that expects a BaseMemory interface.
 */
export class LangChainMemoryAdapter {
  readonly memoryKeys: string[];
  private readonly memoryKey: string;
  private readonly db: RetainDB;

  constructor(
    db: RetainDB,
    private readonly options: LangChainMemoryAdapterOptions,
  ) {
    this.db = db;
    this.memoryKey = options.memoryKey || "history";
    this.memoryKeys = [this.memoryKey];
  }

  async loadMemoryVariables(inputValues: Record<string, unknown>): Promise<Record<string, string>> {
    // Use the actual user input as the search query so retrieved memories are relevant
    const query = typeof inputValues.input === "string" && inputValues.input.trim()
      ? inputValues.input
      : typeof inputValues.question === "string" && inputValues.question.trim()
        ? inputValues.question
        : "recent context";

    const user = this.options.sessionId
      ? this.db.user(this.options.userId).session(this.options.sessionId)
      : this.db.user(this.options.userId);

    const { context } = await user.getContext(query);
    return { [this.memoryKey]: context };
  }

  async saveContext(
    inputValues: Record<string, unknown>,
    outputValues: Record<string, unknown>,
  ): Promise<void> {
    const userInput = typeof inputValues.input === "string" ? inputValues.input
      : typeof inputValues.question === "string" ? inputValues.question
      : JSON.stringify(inputValues);
    const output = typeof outputValues.output === "string" ? outputValues.output
      : typeof outputValues.text === "string" ? outputValues.text
      : JSON.stringify(outputValues);

    // Use remember with a conversation array so the engine extracts facts/preferences
    const user = this.db.user(this.options.userId);
    const sid = this.options.sessionId || `lc-${this.options.userId}`;
    await user.session(sid).remember([
      { role: "user", content: userInput },
      { role: "assistant", content: output },
    ]);
  }

  async clear(): Promise<void> {
    // no-op by default — RetainDB memories are durable by design.
    // Call db.user(id).forget(memoryId) explicitly if you need targeted deletion.
  }
}

export function createLangChainMemoryAdapter(
  db: RetainDB,
  options: LangChainMemoryAdapterOptions,
): LangChainMemoryAdapter {
  return new LangChainMemoryAdapter(db, options);
}
