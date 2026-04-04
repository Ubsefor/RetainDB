import type { MemoryModule } from "./memory.js";

export class ProfileModule {
  constructor(private readonly memory: MemoryModule) {}

  async getUserProfile(params: {
    project?: string;
    user_id: string;
    include_pending?: boolean;
    memory_types?: string;
  }) {
    return this.memory.getUserProfile(params);
  }

  async getSessionMemories(params: {
    project?: string;
    session_id: string;
    include_pending?: boolean;
    limit?: number;
  }) {
    return this.memory.getSessionMemories(params);
  }
}
