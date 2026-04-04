export function normalizeExactMemory(memory) {
  if (!memory) return null;
  return {
    id: memory.id ? String(memory.id) : null,
    type: memory.type ? String(memory.type) : memory.memoryType ? String(memory.memoryType) : null,
    content: String(memory.content || ""),
    user_id: memory.user_id ? String(memory.user_id) : memory.userId ? String(memory.userId) : null,
    session_id: memory.session_id ? String(memory.session_id) : memory.sessionId ? String(memory.sessionId) : null,
    updated_at: memory.updated_at ? String(memory.updated_at) : memory.updatedAt ? String(memory.updatedAt) : null,
    metadata: memory.metadata && typeof memory.metadata === "object" && !Array.isArray(memory.metadata)
      ? memory.metadata
      : null,
  };
}

export function normalizeSearchResults(results) {
  return (results || []).map((result) => {
    const candidate = result?.memory ? result.memory : result;
    const similarity = result?.similarity;
    return {
      id: candidate?.id ? String(candidate.id) : null,
      content: String(candidate?.content || result?.content || ""),
      score:
        typeof similarity === "number"
          ? similarity
          : typeof result?.score === "number"
            ? result.score
            : similarity != null
              ? Number(similarity)
              : result?.score != null
                ? Number(result.score)
                : null,
      source: result?.source ? String(result.source) : result?.chunk ? "memory" : null,
      document: result?.document ? String(result.document) : result?.chunk?.id ? String(result.chunk.id) : null,
      metadata:
        result?.metadata && typeof result.metadata === "object" && !Array.isArray(result.metadata)
          ? result.metadata
          : candidate?.metadata && typeof candidate.metadata === "object" && !Array.isArray(candidate.metadata)
            ? candidate.metadata
            : null,
      memory_type: candidate?.type ? String(candidate.type) : candidate?.memory_type ? String(candidate.memory_type) : null,
    };
  });
}

export function normalizeCanonicalResults(input) {
  if (Array.isArray(input?.results)) return input.results;
  if (Array.isArray(input?.memories)) return input.memories;
  return [];
}

export function buildPrimaryToolSuccess(payload) {
  return {
    success: true,
    ...payload,
  };
}

export function buildPrimaryToolError(message, options = {}) {
  return {
    success: false,
    error: {
      code: options.code ?? "tool_error",
      message,
    },
  };
}

export function buildMcpSearchPayload(input) {
  const normalizedResults = normalizeSearchResults(input.results);
  return buildPrimaryToolSuccess({
    mode: input.mode,
    query: input.query ?? null,
    id: input.id ?? null,
    exact_memory: normalizeExactMemory(input.exactMemory),
    context: input.context ?? "",
    results: normalizedResults,
    count: normalizedResults.length,
    degraded_mode: Boolean(input.degradedMode),
    degraded_reason: input.degradedReason ?? null,
    semantic_status: input.semanticStatus ?? (input.degradedMode ? "failed" : "ok"),
    fallback_mode: input.fallbackMode ?? (input.degradedMode ? "lexical_backend" : "none"),
    recommended_fixes: input.recommendedFixes || [],
    warnings: input.warnings || [],
  });
}

export function buildMcpSearchError(message, options = {}) {
  return buildPrimaryToolError(message, {
    code: options.code ?? "invalid_request",
  });
}
