import { RuntimeClientError } from "../core/client.js";
import { nowIso, stableHash } from "../core/utils.js";
import type { MemoryModule } from "./memory.js";

type SessionState = "created" | "active" | "suspended" | "resumed" | "ended" | "archived";

interface LocalSession {
  sessionId: string;
  project: string;
  userId: string;
  state: SessionState;
  sequence: number;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

function randomSessionId(): string {
  return `sess_${stableHash(`${Date.now()}_${Math.random()}`)}`;
}

function assertTransition(current: SessionState, next: SessionState): void {
  const allowed: Record<SessionState, SessionState[]> = {
    created: ["active", "ended", "archived"],
    active: ["suspended", "ended", "archived"],
    suspended: ["resumed", "ended", "archived"],
    resumed: ["suspended", "ended", "archived"],
    ended: ["archived"],
    archived: [],
  };
  if (!allowed[current].includes(next)) {
    throw new RuntimeClientError({
      code: "INVALID_SESSION_STATE",
      message: `Invalid session transition ${current} -> ${next}`,
      retryable: false,
    });
  }
}

export class SessionModule {
  private readonly sessions = new Map<string, LocalSession>();

  constructor(private readonly memory: MemoryModule, private readonly defaultProject?: string) {}

  private resolveProject(project?: string): string {
    const value = project || this.defaultProject;
    if (!value) {
      throw new RuntimeClientError({
        code: "MISSING_PROJECT",
        message: "Project is required",
        retryable: false,
      });
    }
    return value;
  }

  private ensure(sessionId: string): LocalSession {
    const found = this.sessions.get(sessionId);
    if (!found) {
      throw new RuntimeClientError({
        code: "SESSION_NOT_FOUND",
        message: `Unknown session ${sessionId}`,
        retryable: false,
      });
    }
    return found;
  }

  async start(params: {
    userId: string;
    project?: string;
    sessionId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ sessionId: string; state: SessionState; createdAt: string }> {
    const project = this.resolveProject(params.project);
    const sessionId = params.sessionId || randomSessionId();
    const now = nowIso();
    const record: LocalSession = {
      sessionId,
      project,
      userId: params.userId,
      state: "active",
      sequence: 0,
      metadata: params.metadata,
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(sessionId, record);
    return {
      sessionId,
      state: record.state,
      createdAt: now,
    };
  }

  async event(params: {
    sessionId: string;
    type: string;
    content: string;
    parentEventId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ success: boolean; eventId: string; sequence: number }> {
    const session = this.ensure(params.sessionId);
    if (session.state !== "active" && session.state !== "resumed") {
      throw new RuntimeClientError({
        code: "INVALID_SESSION_STATE",
        message: `Cannot append event in ${session.state} state`,
        retryable: false,
      });
    }

    session.sequence += 1;
    session.updatedAt = nowIso();
    const eventId = `evt_${stableHash(JSON.stringify({
      sessionId: session.sessionId,
      seq: session.sequence,
      type: params.type,
      content: params.content,
      parent: params.parentEventId || "",
    }))}`;

    await this.memory.add({
      project: session.project,
      content: `${params.type}: ${params.content}`,
      memory_type: "event",
      user_id: session.userId,
      session_id: session.sessionId,
      metadata: {
        session_event: true,
        event_id: eventId,
        sequence: session.sequence,
        parent_event_id: params.parentEventId,
        ...session.metadata,
        ...(params.metadata || {}),
      },
      write_mode: "async",
    });

    return {
      success: true,
      eventId,
      sequence: session.sequence,
    };
  }

  async suspend(params: { sessionId: string }): Promise<{ sessionId: string; state: SessionState }> {
    const session = this.ensure(params.sessionId);
    assertTransition(session.state, "suspended");
    session.state = "suspended";
    session.updatedAt = nowIso();
    return { sessionId: session.sessionId, state: session.state };
  }

  async resume(params: { sessionId: string }): Promise<{ sessionId: string; state: SessionState }> {
    const session = this.ensure(params.sessionId);
    const target = session.state === "suspended" ? "resumed" : "active";
    assertTransition(session.state, target);
    session.state = target;
    session.updatedAt = nowIso();
    return { sessionId: session.sessionId, state: session.state };
  }

  async end(params: { sessionId: string }): Promise<{ sessionId: string; state: SessionState }> {
    const session = this.ensure(params.sessionId);
    assertTransition(session.state, "ended");
    session.state = "ended";
    session.updatedAt = nowIso();
    return { sessionId: session.sessionId, state: session.state };
  }

  async archive(params: { sessionId: string }): Promise<{ sessionId: string; state: SessionState }> {
    const session = this.ensure(params.sessionId);
    assertTransition(session.state, "archived");
    session.state = "archived";
    session.updatedAt = nowIso();
    return { sessionId: session.sessionId, state: session.state };
  }
}
