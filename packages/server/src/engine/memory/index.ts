/**
 * SOTA Memory System - Main Export
 *
 * State-of-the-Art memory architecture for AI agents
 * Targets 85%+ on LongMemEval (beats Supermemory's 81.6%)
 *
 * Features:
 * - Temporal reasoning with dual timestamps (documentDate + eventDate)
 * - Relational versioning (updates/extends/derives/contradicts/supports)
 * - Memory disambiguation (resolves pronouns and ambiguous references)
 * - Knowledge graphs for context enrichment
 * - Memory-first hybrid search
 * - Session-based ingestion
 */

// Types
export * from "./types.js";

// Memory Extraction
export {
  extractMemories,
  extractMemoriesForSession,
  shouldExtractMemory,
} from "./extractor-unified.js";

// Relation Detection
export {
  detectRelations,
  shouldInvalidateMemory,
  buildRelationGraph,
  getVersionChain,
} from "./relations.js";

// Temporal Reasoning
export {
  parseTemporalQuery,
  calculateRelativeDateRange,
  extractEventDate,
  isMemoryValidAt,
  getMemoryVersionAt,
  calculateTemporalRelevance,
  buildTimeline,
} from "./temporal.js";

// Memory Search
export {
  searchMemories,
  getSessionMemories,
  getUserProfile,
} from "./search.js";

// Memory Ingestion
export {
  ingestSession,
  ingestChunk,
  ingestChunksBatch,
  updateMemory,
} from "./ingest.js";

// Canonical Memory Write
export {
  MEMORY_WRITE_POLICY_VERSION,
  AGENT_SCOPE_THRESHOLD,
  PROJECT_SCOPE_THRESHOLD,
  SESSION_ONLY_THRESHOLD,
  TASK_SCOPE_THRESHOLD,
  USER_PROFILE_THRESHOLD,
  writeMemoryCanonical,
} from "./write.js";
