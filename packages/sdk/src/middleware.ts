import { Whisper } from "./whisper-agent.js";
import type { WhisperOptions } from "./whisper-agent.js";

export interface AgentMiddlewareConfig extends WhisperOptions {
  /**
   * Build the prompt passed to the model.
   */
  promptBuilder?: (params: { context: string; userMessage: string }) => string;
}

export interface AgentTurnParams {
  userMessage: string;
  userId?: string;
  sessionId?: string;
  project?: string;
  contextLimit?: number;
  auto_learn?: boolean;
}

export interface AgentTurnResult {
  prompt: string;
  context: string;
  contextCount: number;
}

export interface WrappedGenerateResult {
  response: string;
  prompt: string;
  context: string;
  contextCount: number;
  extracted: number;
}

/**
 * Drop-in middleware for existing AI agents.
 *
 * Typical flow:
 * 1) beforeTurn -> retrieve context
 * 2) call your model
 * 3) afterTurn -> store memories
 */
export class WhisperAgentMiddleware {
  private readonly whisper: Whisper;
  private readonly promptBuilder: (params: { context: string; userMessage: string }) => string;

  constructor(config: AgentMiddlewareConfig) {
    this.whisper = new Whisper(config);
    this.promptBuilder = config.promptBuilder || (({ context, userMessage }) => {
      if (!context) return userMessage;
      return `${context}\n\nUser: ${userMessage}`;
    });
  }

  async beforeTurn(params: AgentTurnParams): Promise<AgentTurnResult> {
    const contextResult = await this.whisper.getContext(params.userMessage, {
      userId: params.userId,
      sessionId: params.sessionId,
      project: params.project,
      limit: params.contextLimit,
    });

    const prompt = this.promptBuilder({
      context: contextResult.context,
      userMessage: params.userMessage,
    });

    return {
      prompt,
      context: contextResult.context,
      contextCount: contextResult.count,
    };
  }

  async afterTurn(params: {
    userMessage: string;
    assistantMessage: string;
    userId?: string;
    sessionId?: string;
    project?: string;
    auto_learn?: boolean;
  }): Promise<{ success: boolean; extracted: number }> {
    return this.whisper.captureSession(
      [
        { role: "user", content: params.userMessage },
        { role: "assistant", content: params.assistantMessage },
      ],
      {
        userId: params.userId,
        sessionId: params.sessionId,
        project: params.project,
        auto_learn: params.auto_learn,
      }
    );
  }

  async wrapGenerate(
    params: AgentTurnParams & {
      generate: (prompt: string) => Promise<string>;
    }
  ): Promise<WrappedGenerateResult> {
    const before = await this.beforeTurn(params);
    const response = await params.generate(before.prompt);
    const after = await this.afterTurn({
      userMessage: params.userMessage,
      assistantMessage: response,
      userId: params.userId,
      sessionId: params.sessionId,
      project: params.project,
      auto_learn: params.auto_learn,
    });

    return {
      response,
      prompt: before.prompt,
      context: before.context,
      contextCount: before.contextCount,
      extracted: after.extracted,
    };
  }

  raw(): Whisper {
    return this.whisper;
  }
}

export function createAgentMiddleware(config: AgentMiddlewareConfig): WhisperAgentMiddleware {
  return new WhisperAgentMiddleware(config);
}

