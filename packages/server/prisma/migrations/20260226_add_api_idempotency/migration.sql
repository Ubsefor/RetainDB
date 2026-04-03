-- Idempotency records for write endpoints (memory/create flows).
CREATE TABLE IF NOT EXISTS api_idempotency (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status_code INT NOT NULL,
  response_body JSONB NOT NULL DEFAULT '{}'::jsonb,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT api_idempotency_org_endpoint_key_unique UNIQUE (org_id, endpoint, idempotency_key)
);

CREATE INDEX IF NOT EXISTS api_idempotency_expires_at_idx
  ON api_idempotency (expires_at);

CREATE INDEX IF NOT EXISTS api_idempotency_org_endpoint_idx
  ON api_idempotency (org_id, endpoint);
