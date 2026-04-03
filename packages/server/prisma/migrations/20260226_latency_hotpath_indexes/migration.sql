-- Latency hot-path indexes for context + memory search.

-- Context retrieval filters
CREATE INDEX IF NOT EXISTS chunks_project_id_idx ON chunks ("projectId");
CREATE INDEX IF NOT EXISTS chunks_project_chunk_type_idx ON chunks ("projectId", "chunkType");

-- PostgreSQL FTS for /v1/context/query hybrid path
CREATE INDEX IF NOT EXISTS chunks_search_fts_idx
  ON chunks
  USING GIN (to_tsvector('english', coalesce("searchContent", content)));

-- Cache lookup/eviction support (legacy DB cache table still used by ops tooling)
CREATE INDEX IF NOT EXISTS query_cache_project_expires_idx ON query_cache ("projectId", "expiresAt");

-- Memory search filter acceleration
CREATE INDEX IF NOT EXISTS memories_project_active_expiry_idx
  ON memories ("projectId", "isActive", "expiresAt");

CREATE INDEX IF NOT EXISTS memories_project_user_session_active_expiry_idx
  ON memories ("projectId", "userId", "sessionId", "isActive", "expiresAt");
